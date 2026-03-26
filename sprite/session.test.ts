/// <reference types="vitest" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "child_process";
import WebSocket from "ws";

// ─── Test config ─────────────────────────────────────────────────────────────

const SERVER_PORT = 18989; // avoid conflict with real server
const TTYD_PORT = 17682; // not actually used, but server expects it
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const WS_URL = `ws://localhost:${SERVER_PORT}/ws/extension`;

// ─── Server lifecycle ────────────────────────────────────────────────────────

let serverProc: ChildProcess;

beforeAll(async () => {
  // Start the server with test ports.
  // We use a dummy ttyd port — the proxy will fail but that's fine,
  // we're testing the session/command channel, not the terminal proxy.
  serverProc = spawn("node", ["server.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      BROWSERBUD_PORT: String(SERVER_PORT),
      BROWSERBUD_TTYD_PORT: String(TTYD_PORT),
      BROWSERBUD_LOG_LEVEL: "warn",
      // Set a data dir that won't interfere with real data
      BROWSERBUD_DATA_DIR: "/tmp/browserbud-test-data",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for server to be ready (poll /api/session)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER_URL}/api/session`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}, 15_000);

afterAll(() => {
  if (serverProc) {
    serverProc.kill("SIGTERM");
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function connectPanel(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

async function getSession(): Promise<any> {
  const res = await fetch(`${SERVER_URL}/api/session`);
  return res.json();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Session model", () => {
  it("reports panelConnected=false when no panel is connected", async () => {
    const session = await getSession();
    expect(session.panelConnected).toBe(false);
    expect(session.capabilities).toEqual([]);
  });

  it("reports panelConnected=true when panel connects", async () => {
    const ws = await connectPanel();
    try {
      // Give server a moment to process the connection
      await new Promise((r) => setTimeout(r, 100));
      const session = await getSession();
      expect(session.panelConnected).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("reports panelConnected=false after panel disconnects", async () => {
    const ws = await connectPanel();
    await new Promise((r) => setTimeout(r, 100));

    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    const session = await getSession();
    expect(session.panelConnected).toBe(false);
  });

  it("updates session on panel-hello", async () => {
    const ws = await connectPanel();
    try {
      ws.send(JSON.stringify({
        type: "panel-hello",
        activeTabId: 123,
        activeTabUrl: "https://example.com",
        capabilities: ["getContext", "getPageContent"],
      }));
      await new Promise((r) => setTimeout(r, 100));

      const session = await getSession();
      expect(session.panelConnected).toBe(true);
      expect(session.activeTabUrl).toBe("https://example.com");
      expect(session.capabilities).toEqual(["getContext", "getPageContent"]);
    } finally {
      ws.close();
    }
  });

  it("updates session on session-update", async () => {
    const ws = await connectPanel();
    try {
      ws.send(JSON.stringify({
        type: "session-update",
        activeTabUrl: "https://youtube.com/watch?v=abc",
        capabilities: ["getContext", "extractTranscript"],
      }));
      await new Promise((r) => setTimeout(r, 100));

      const session = await getSession();
      expect(session.activeTabUrl).toBe("https://youtube.com/watch?v=abc");
      expect(session.capabilities).toEqual(["getContext", "extractTranscript"]);
    } finally {
      ws.close();
    }
  });

  it("clears session fields on disconnect", async () => {
    const ws = await connectPanel();
    ws.send(JSON.stringify({
      type: "panel-hello",
      activeTabId: 456,
      activeTabUrl: "https://example.com",
      capabilities: ["getContext"],
    }));
    await new Promise((r) => setTimeout(r, 100));

    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    const session = await getSession();
    expect(session.panelConnected).toBe(false);
    expect(session.activeTabUrl).toBeNull();
    expect(session.capabilities).toEqual([]);
  });
});

describe("Ping/pong heartbeat", () => {
  it("responds to ping with pong", async () => {
    const ws = await connectPanel();
    try {
      const pongPromise = waitForMessage(ws, (msg) => msg.type === "pong");
      ws.send(JSON.stringify({ type: "ping" }));
      const msg = await pongPromise;
      expect(msg.type).toBe("pong");
    } finally {
      ws.close();
    }
  });
});

describe("Command dispatch errors", () => {
  it("returns 503 with no_active_panel_session when no panel connected", async () => {
    // Ensure no panel is connected
    const session = await getSession();
    if (session.panelConnected) {
      // Wait a moment for any previous test's panel to disconnect
      await new Promise((r) => setTimeout(r, 500));
    }

    const res = await fetch(`${SERVER_URL}/api/extract-page-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_active_panel_session");
  }, 15_000);

  it("sends command to panel and receives result", async () => {
    const ws = await connectPanel();
    try {
      // Start listening for the command before making the HTTP request
      const commandPromise = waitForMessage(ws, (msg) => msg.type === "get-page-content");

      // Make the HTTP request (don't await yet)
      const httpPromise = fetch(`${SERVER_URL}/api/extract-page-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      // Wait for the command to arrive on the WebSocket
      const cmd = await commandPromise;
      expect(cmd.type).toBe("get-page-content");
      expect(cmd.requestId).toBeTruthy();

      // Send back a mock result
      ws.send(JSON.stringify({
        type: "page-content-result",
        requestId: cmd.requestId,
        success: true,
        content: "Hello, world!",
        title: "Test Page",
        url: "https://example.com",
      }));

      // Verify the HTTP response
      const res = await httpPromise;
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.content).toBe("Hello, world!");
      expect(body.title).toBe("Test Page");
    } finally {
      ws.close();
    }
  });

  it("sends extract-transcript command with videoId", async () => {
    const ws = await connectPanel();
    try {
      const commandPromise = waitForMessage(ws, (msg) => msg.type === "extract-transcript");

      const httpPromise = fetch(`${SERVER_URL}/api/extract-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "dQw4w9WgXcQ" }),
      });

      const cmd = await commandPromise;
      expect(cmd.type).toBe("extract-transcript");
      expect(cmd.videoId).toBe("dQw4w9WgXcQ");

      ws.send(JSON.stringify({
        type: "extract-transcript-result",
        requestId: cmd.requestId,
        success: true,
        text: "Never gonna give you up",
        lang: "en",
        meta: {},
      }));

      const res = await httpPromise;
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.text).toBe("Never gonna give you up");
    } finally {
      ws.close();
    }
  });

  it("returns error when panel sends failure result", async () => {
    const ws = await connectPanel();
    try {
      const commandPromise = waitForMessage(ws, (msg) => msg.type === "get-page-content");

      const httpPromise = fetch(`${SERVER_URL}/api/extract-page-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const cmd = await commandPromise;

      ws.send(JSON.stringify({
        type: "page-content-result",
        requestId: cmd.requestId,
        success: false,
        error: "No active tab found",
      }));

      const res = await httpPromise;
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("No active tab found");
    } finally {
      ws.close();
    }
  });

  it("rejects pending requests when panel disconnects mid-command", async () => {
    const ws = await connectPanel();

    const commandPromise = waitForMessage(ws, (msg) => msg.type === "get-page-content");

    const httpPromise = fetch(`${SERVER_URL}/api/extract-page-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    // Wait for the command to arrive, then disconnect without responding
    await commandPromise;
    ws.close();

    const res = await httpPromise;
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("disconnected");
  });
});
