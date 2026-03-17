const http = require("http");
const fs = require("fs");
const path = require("path");
const httpProxy = require("http-proxy");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const TTYD_PORT = 7681;
const PROXY_PORT = 8080;
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(process.env.HOME, "browse");
const CONTEXT_DIR = path.join(DATA_DIR, "context");
const CONTEXT_FILE = path.join(CONTEXT_DIR, "current.json");
const CACHE_DIR = path.join(DATA_DIR, "cache", "youtube");

// ─── IDE MCP WebSocket Server ───────────────────────────────────────────────

const IDE_DIR = path.join(process.env.HOME, ".claude", "ide");
const authToken = uuidv4();
let mcpPort = null;
const connectedClients = new Set();

function startMcpServer() {
  fs.mkdirSync(IDE_DIR, { recursive: true });

  const mcpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  mcpServer.on("upgrade", (req, socket, head) => {
    const token = req.headers["x-claude-code-ide-authorization"];
    if (token !== authToken) {
      console.log("[MCP] Auth rejected");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    console.log("[MCP] Claude Code connected");
    connectedClients.add(ws);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        console.log("[MCP] Received:", msg.method || `response:${msg.id}`);
        handleMcpMessage(ws, msg);
      } catch (err) {
        console.error("[MCP] Bad message:", err.message);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[MCP] Claude Code disconnected (code: ${code}, reason: ${reason})`);
      connectedClients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("[MCP] WebSocket error:", err.message);
    });

    // Ping every 30s
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);
    ws.on("close", () => clearInterval(pingInterval));
  });

  // Listen on random port, localhost only
  mcpServer.listen(0, "127.0.0.1", () => {
    mcpPort = mcpServer.address().port;
    console.log(`[MCP] IDE server listening on 127.0.0.1:${mcpPort}`);
    // Write port to file so start.sh can pass it as CLAUDE_CODE_SSE_PORT
    // Note: we intentionally do NOT write a lock file — the ttyd Claude instance
    // connects via CLAUDE_CODE_SSE_PORT env var. A lock file would cause every
    // Claude instance on this machine to discover and connect, polluting their
    // context with browser data.
    fs.writeFileSync(path.join(IDE_DIR, "browserbud.port"), String(mcpPort));
  });

  return mcpServer;
}

function handleMcpMessage(ws, msg) {
  const { id, method } = msg;

  if (method === "initialize") {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "browserbud",
          version: "0.1.0",
        },
      },
    }));
  } else if (method === "notifications/initialized") {
    // No response needed
  } else if (method === "tools/list") {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { tools: [] },
    }));
  } else if (id) {
    // Unknown method with id — send empty result
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {},
    }));
  }
}

function removeLockFile() {
  // Clean up any stale lock files from previous runs that used lock file discovery
  if (mcpPort) {
    const lockPath = path.join(IDE_DIR, `${mcpPort}.lock`);
    try {
      fs.unlinkSync(lockPath);
      console.log(`[MCP] Stale lock file removed: ${lockPath}`);
    } catch {}
  }
}

function broadcastSelection(context) {
  const site = context.site || "";
  const title = context.title || "";
  const url = context.url || "";

  // Map browser context to selection_changed format
  const displayText = site && title ? `${site}: ${title}` : "";
  const filePath = url || "";

  const notification = JSON.stringify({
    jsonrpc: "2.0",
    method: "selection_changed",
    params: {
      text: displayText,
      filePath,
      fileUrl: filePath,
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
        isEmpty: true,
      },
    },
  });

  for (const ws of connectedClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(notification);
    }
  }
  console.log(`[MCP] Broadcast selection_changed to ${connectedClients.size} client(s): ${displayText}`);
}

// ─── HTTP Proxy + Context API ───────────────────────────────────────────────

const proxy = httpProxy.createProxyServer({
  target: `http://localhost:${TTYD_PORT}`,
  ws: true,
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);
  if (res.writeHead) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway — ttyd not ready");
  }
});

function handleContext(req, res) {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const context = JSON.parse(body);
        context.timestamp = new Date().toISOString();
        fs.mkdirSync(CONTEXT_DIR, { recursive: true });
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(context, null, 2));

        // Push to Claude Code via MCP
        broadcastSelection(context);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  } else if (req.method === "GET") {
    try {
      const data = fs.readFileSync(CONTEXT_FILE, "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    }
  }
}

function handleTranscript(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const { videoId, text, meta, lang, source } = JSON.parse(body);

      if (!videoId || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "videoId and text are required" }));
        return;
      }

      const videoDir = path.join(CACHE_DIR, videoId);

      // Skip if already cached (don't overwrite server-side fetched transcripts)
      if (fs.existsSync(path.join(videoDir, "transcript.md"))) {
        console.log(`[Transcript] Already cached: ${videoId}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, videoId, cached: true, existing: true }));
        return;
      }

      fs.mkdirSync(videoDir, { recursive: true });

      // Build metadata for the markdown header
      const title = meta?.title || videoId;
      const channel = meta?.channel || "Unknown";
      const duration = meta?.duration || "";
      const url = meta?.url || `https://www.youtube.com/watch?v=${videoId}`;

      // Format transcript markdown (same format as yt-research skill)
      const mdLines = [
        `# ${title}`,
        "",
        `- **Channel:** ${channel}`,
        ...(duration ? [`- **Duration:** ${duration}`] : []),
        `- **URL:** ${url}`,
        `- **Transcript source:** ${source || "client"}`,
        ...(lang ? [`- **Language:** ${lang}`] : []),
        `- **Cached:** ${new Date().toISOString()}`,
        "",
        "---",
        "",
        "## Transcript",
        "",
        text,
        "",
      ];

      fs.writeFileSync(path.join(videoDir, "transcript.md"), mdLines.join("\n"));
      fs.writeFileSync(path.join(videoDir, "transcript.txt"), text);
      fs.writeFileSync(
        path.join(videoDir, "meta.json"),
        JSON.stringify(
          {
            title,
            channel,
            duration,
            url,
            videoId,
            source: source || "client",
            lang: lang || "en",
            cachedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      console.log(`[Transcript] Cached ${videoId}: ${text.length} chars via ${source || "client"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, videoId, cached: true }));
    } catch (err) {
      console.error("[Transcript] Error:", err.message);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
  });
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/api/context") {
    return handleContext(req, res);
  }

  if (req.url === "/api/transcript") {
    return handleTranscript(req, res);
  }

  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

// ─── Startup & Cleanup ─────────────────────────────────────────────────────

const mcpServer = startMcpServer();

server.listen(PROXY_PORT, () => {
  console.log(`Proxy server listening on port ${PROXY_PORT}, forwarding to ttyd on port ${TTYD_PORT}`);
});

function cleanup() {
  removeLockFile();
  process.exit();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("exit", removeLockFile);
