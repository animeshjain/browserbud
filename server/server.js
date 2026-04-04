const http = require("http");
const fs = require("fs");
const path = require("path");
const httpProxy = require("http-proxy");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const { execSync } = require("child_process");
const os = require("os");
const pino = require("pino");
const TurndownService = require("turndown");
const { JSDOM } = require("jsdom");

// ─── Logging ────────────────────────────────────────────────────────────────

const log = pino({
  level: process.env.BROWSERBUD_LOG_LEVEL || "info",
  transport: {
    target: "pino/file",
    options: { destination: 1 }, // stdout
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const startTime = Date.now();
const TTYD_PORT = parseInt(process.env.BROWSERBUD_TTYD_PORT, 10);
const PROXY_PORT = parseInt(process.env.BROWSERBUD_PORT, 10);
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(os.homedir(), "browse");
const CONTEXT_DIR = path.join(DATA_DIR, "context");
const CONTEXT_FILE = path.join(CONTEXT_DIR, "current.json");
const CACHE_DIR = path.join(DATA_DIR, "cache", "youtube");

// ─── Terminal Bridge Script ─────────────────────────────────────────────────
// Built from server/bridge/terminal_bridge.ts via `npm run build:bridge`.
// Injected into ttyd's HTML page. Captures the ttyd WebSocket and listens for
// postMessage from the extension side panel to type text into the terminal.

const BRIDGE_BUILT_PATH = path.join(__dirname, "bridge", "terminal_bridge.built.js");
if (!fs.existsSync(BRIDGE_BUILT_PATH)) {
  console.error(
    "ERROR: Terminal bridge not built. Run 'npm run build:bridge' from the repo root, " +
    "or use 'bash server/start.sh' which builds it automatically."
  );
  process.exit(1);
}
const BRIDGE_SCRIPT = fs.readFileSync(BRIDGE_BUILT_PATH, "utf-8");

// ─── IDE MCP WebSocket Server ───────────────────────────────────────────────

const IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const authToken = uuidv4();
let mcpPort = null;
const connectedClients = new Set();
const readyClients = new Set();

function loadCurrentContext() {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8"));
  } catch {
    return {};
  }
}

let lastContext = loadCurrentContext();

function buildSelectionNotification(context) {
  const site = context.site || "";
  const title = context.title || "";
  const url = context.url || "";
  const selection = context.selection;

  let displayText = site && title ? `${site}: ${title}` : "";
  if (selection && selection.lineCount > 0) {
    displayText += ` (${selection.lineCount} line${selection.lineCount > 1 ? "s" : ""} selected)`;
  }

  // Always point Claude to the file for selections — the MCP notification
  // text field gets truncated by Claude Code for large content.
  const selectionFile = path.join(CONTEXT_DIR, "selection.txt");
  let textContent;
  if (selection?.text) {
    textContent = `${displayText}\n\nSelected text saved to: ${selectionFile}`;
  } else {
    textContent = displayText;
  }

  const filePath = selection?.text ? selectionFile : (url || "");

  return {
    notification: JSON.stringify({
      jsonrpc: "2.0",
      method: "selection_changed",
      params: {
        text: textContent,
        filePath,
        fileUrl: filePath,
        selection: {
          start: { line: 0, character: 0 },
          end: { line: selection?.lineCount || 0, character: 0 },
          isEmpty: !selection?.text,
        },
      },
    }),
    displayText,
    filePath,
  };
}

function sendSelection(ws, context) {
  if (ws.readyState !== ws.OPEN) return;
  const { notification } = buildSelectionNotification(context);
  ws.send(notification);
}

function maybeSendCurrentContext(ws) {
  if (!connectedClients.has(ws) || readyClients.has(ws)) return;
  readyClients.add(ws);
  // Delay slightly so Claude Code finishes processing the tools/list response
  // before we push a selection_changed notification
  const ctx = lastContext;
  const displayText = (ctx.site && ctx.title) ? `${ctx.site}: ${ctx.title}` : "(empty)";
  log.info({ displayText }, "replaying context to new client in 500ms");
  setTimeout(() => sendSelection(ws, ctx), 500);
}

function restoreHiddenLockFiles() {
  try {
    const files = fs.readdirSync(IDE_DIR).filter(f => f.endsWith(".browserbud-hidden"));
    for (const f of files) {
      const hidden = path.join(IDE_DIR, f);
      const original = path.join(IDE_DIR, f.replace(".browserbud-hidden", ""));
      fs.renameSync(hidden, original);
      log.info({ file: f }, "restored hidden lock file");
    }
  } catch (err) {
    log.debug({ err: err.message }, "no hidden lock files to restore");
  }
}

function startMcpServer() {
  fs.mkdirSync(IDE_DIR, { recursive: true });

  const mcpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  mcpServer.on("upgrade", (req, socket, head) => {
    const token = req.headers["x-claude-code-ide-authorization"];
    if (token !== authToken) {
      log.debug({ remoteAddr: req.socket.remoteAddress }, "mcp auth rejected");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    log.debug({ remoteAddr: req.socket.remoteAddress }, "mcp auth ok");
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    log.info("Claude Code connected");
    connectedClients.add(ws);
    restoreHiddenLockFiles();

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        log.debug({ method: msg.method, id: msg.id }, "mcp message received");
        handleMcpMessage(ws, msg);
      } catch (err) {
        log.warn({ err: err.message }, "mcp bad message");
      }
    });

    ws.on("close", () => {
      log.info("Claude Code disconnected");
      connectedClients.delete(ws);
      readyClients.delete(ws);
    });

    ws.on("error", (err) => {
      log.error({ err: err.message }, "mcp websocket error");
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
    log.info({ port: mcpPort }, "mcp server listening");
    fs.writeFileSync(path.join(IDE_DIR, "browserbud.port"), String(mcpPort));

    // Write a lock file so Claude Code discovers us (same format as VS Code / JetBrains plugins)
    const lockData = JSON.stringify({
      workspaceFolders: [DATA_DIR],
      pid: process.pid,
      ideName: "BrowserBud",
      transport: "ws",
      runningInWindows: false,
      authToken,
    });
    const lockPath = path.join(IDE_DIR, `${mcpPort}.lock`);
    fs.writeFileSync(lockPath, lockData);
    log.info({ lockPath }, "lock file written");
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
    maybeSendCurrentContext(ws);
    bannerReady("claude");
  } else if (id) {
    // Unknown method with id — send empty result
    log.debug({ method, id }, "mcp unknown method");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {},
    }));
  }
}

function removeLockFile() {
  if (mcpPort) {
    const lockPath = path.join(IDE_DIR, `${mcpPort}.lock`);
    try {
      fs.unlinkSync(lockPath);
      log.debug({ lockPath }, "lock file removed");
    } catch {}
  }
}

function broadcastSelection(context) {
  lastContext = context;
  const { notification, displayText, filePath } = buildSelectionNotification(context);

  for (const ws of readyClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(notification);
    }
  }
  if (displayText) {
    log.info({ clients: readyClients.size }, displayText);
  } else {
    log.info({ clients: readyClients.size }, "context cleared");
  }
  log.debug({ displayText, filePath }, "broadcast selection_changed");
}

// ─── Extension WebSocket (bidirectional command channel) ────────────────────

let extensionWs = null;
const pendingRequests = new Map(); // requestId -> { resolve, reject, timer }

// Session state — tracks the connected panel's capabilities
const session = {
  panelConnected: false,
  activeTabId: null,
  activeTabUrl: null,
  capabilities: [],
};

const extensionWss = new WebSocketServer({ noServer: true });

extensionWss.on("connection", (ws) => {
  log.info("panel connected");
  extensionWs = ws;
  session.panelConnected = true;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);

      // Heartbeat
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // Session updates from the side panel
      if (msg.type === "panel-hello" || msg.type === "session-update") {
        if (msg.activeTabId != null) session.activeTabId = msg.activeTabId;
        if (msg.activeTabUrl != null) session.activeTabUrl = msg.activeTabUrl;
        if (msg.capabilities != null) session.capabilities = msg.capabilities;
        log.info({ session }, "session updated");
        return;
      }

      log.debug({ type: msg.type }, "extension message received");
      if ((msg.type === "extract-transcript-result" || msg.type === "extract-comments-result" || msg.type === "player-state-result" || msg.type === "page-content-result") && msg.requestId) {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.requestId);
          pending.resolve(msg);
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, "extension bad message");
    }
  });

  ws.on("close", () => {
    log.info("panel disconnected");
    if (extensionWs === ws) {
      extensionWs = null;
      session.panelConnected = false;
      session.activeTabId = null;
      session.activeTabUrl = null;
      session.capabilities = [];
    }
    // Reject only pending requests that were sent on this socket
    for (const [id, pending] of pendingRequests) {
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Panel disconnected"));
        pendingRequests.delete(id);
      }
    }
  });

  ws.on("error", (err) => {
    log.error({ err: err.message }, "extension websocket error");
  });

  // Ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);
  ws.on("close", () => clearInterval(pingInterval));
});

function waitForExtension(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
      resolve();
      return;
    }
    const deadline = Date.now() + timeoutMs;
    let delay = 250; // start at 250ms, double each retry
    function check() {
      if (extensionWs && extensionWs.readyState === extensionWs.OPEN) {
        resolve();
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error("no_active_panel_session: BrowserBud side panel is not open. Open it in Chrome to use browser commands."));
        return;
      }
      delay = Math.min(delay * 2, remaining, 4000); // cap at 4s
      log.debug({ delay, remaining }, "waiting for extension to connect");
      setTimeout(check, delay);
    }
    check();
  });
}

async function sendExtensionCommand(command, timeoutMs = 15000) {
  await waitForExtension(10000); // wait up to 10s for extension to connect

  return new Promise((resolve, reject) => {
    const requestId = uuidv4();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Timeout waiting for extension response"));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer, ws: extensionWs });
    extensionWs.send(JSON.stringify({ ...command, requestId }));
  });
}

function handleExtractTranscript(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { videoId } = JSON.parse(body);
      if (!videoId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "videoId is required" }));
        return;
      }

      log.info({ videoId }, "requesting transcript from extension");
      const result = await sendExtensionCommand({
        type: "extract-transcript",
        videoId,
      });

      if (result.success) {
        // Cache the transcript (reuse existing handleTranscript logic)
        const videoDir = path.join(CACHE_DIR, videoId);
        if (!fs.existsSync(path.join(videoDir, "transcript.txt"))) {
          fs.mkdirSync(videoDir, { recursive: true });
          fs.writeFileSync(path.join(videoDir, "transcript.txt"), result.text);
          // Client extraction produces [MM:SS] timestamped lines
          if (result.text.match(/^\[\d{2}:\d{2}\] /m)) {
            fs.writeFileSync(path.join(videoDir, "transcript_timed.txt"), result.text);
          }
          const meta = result.meta || {};
          const mdLines = [
            `# ${meta.title || videoId}`,
            "",
            `- **Channel:** ${meta.channel || "Unknown"}`,
            ...(meta.duration ? [`- **Duration:** ${meta.duration}`] : []),
            `- **URL:** ${meta.url || `https://www.youtube.com/watch?v=${videoId}`}`,
            `- **Transcript source:** client`,
            ...(result.lang ? [`- **Language:** ${result.lang}`] : []),
            `- **Cached:** ${new Date().toISOString()}`,
            "",
            "---",
            "",
            "## Transcript",
            "",
            result.text,
            "",
          ];
          fs.writeFileSync(path.join(videoDir, "transcript.md"), mdLines.join("\n"));
          fs.writeFileSync(
            path.join(videoDir, "meta.json"),
            JSON.stringify({
              title: meta.title || videoId,
              channel: meta.channel || "Unknown",
              duration: meta.duration || "",
              url: meta.url || `https://www.youtube.com/watch?v=${videoId}`,
              videoId,
              source: "client",
              lang: result.lang || "en",
              cachedAt: new Date().toISOString(),
            }, null, 2),
          );
          log.info({ videoId, chars: result.text.length, title: meta.title }, "transcript cached");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          text: result.text,
          lang: result.lang,
          meta: result.meta,
          source: "client",
        }));
      } else {
        log.warn({ videoId, error: result.error }, "transcript extraction failed");
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: result.error || "Extraction failed" }));
      }
    } catch (err) {
      const isNoPanel = err.message.includes("no_active_panel_session");
      log.error({ err: err.message }, "extract-transcript error");
      res.writeHead(isNoPanel ? 503 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, code: isNoPanel ? "no_active_panel_session" : "extension_error" }));
    }
  });
}

function handleExtractComments(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { videoId, maxComments, includeReplies, minLikesForReplies, minRepliesForReplies } = JSON.parse(body);
      if (!videoId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "videoId is required" }));
        return;
      }

      log.info({ videoId, maxComments }, "requesting comments from extension");
      const result = await sendExtensionCommand({
        type: "extract-comments",
        videoId,
        maxComments,
        includeReplies,
        minLikesForReplies,
        minRepliesForReplies,
      }, 60000);

      if (result.success) {
        // Cache the comments
        const videoDir = path.join(CACHE_DIR, videoId);
        fs.mkdirSync(videoDir, { recursive: true });

        const commentsData = {
          comments: result.comments,
          totalCount: result.totalCount,
          videoId,
          fetchedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(videoDir, "comments.json"), JSON.stringify(commentsData, null, 2));

        // Build markdown
        const meta = result.meta || {};
        const mdLines = [
          `# Comments: ${meta.title || videoId}`,
          "",
          `- **Channel:** ${meta.channel || "Unknown"}`,
          `- **URL:** ${meta.url || `https://www.youtube.com/watch?v=${videoId}`}`,
          `- **Total comments:** ${result.totalCount || "unknown"}`,
          `- **Fetched:** ${result.comments.length} comments`,
          `- **Cached:** ${new Date().toISOString()}`,
          "",
          "---",
          "",
        ];

        for (const c of result.comments) {
          const badges = [];
          if (c.isPinned) badges.push("📌 Pinned");
          if (c.isHearted) badges.push("❤️");
          if (c.isCreator) badges.push("🎬 Creator");
          if (c.isVerified) badges.push("✓ Verified");
          const badgeStr = badges.length > 0 ? " " + badges.join(" ") : "";

          mdLines.push(`**${c.author}** · ${c.publishedTime} · 👍 ${c.likes}${c.replyCount && c.replyCount !== "0" ? ` · 💬 ${c.replyCount}` : ""}${badgeStr}`);
          mdLines.push(c.text);

          if (c.replies && c.replies.length > 0) {
            mdLines.push("");
            for (const r of c.replies) {
              const rBadges = [];
              if (r.isCreator) rBadges.push("🎬 Creator");
              if (r.isVerified) rBadges.push("✓ Verified");
              const rBadgeStr = rBadges.length > 0 ? " " + rBadges.join(" ") : "";
              mdLines.push(`> **${r.author}** · ${r.publishedTime} · 👍 ${r.likes}${rBadgeStr}`);
              mdLines.push(`> ${r.text.replace(/\n/g, "\n> ")}`);
              mdLines.push(">");
            }
          }

          mdLines.push("");
        }

        fs.writeFileSync(path.join(videoDir, "comments.md"), mdLines.join("\n"));
        log.info({ videoId, count: result.comments.length, total: result.totalCount, title: meta.title }, "comments cached");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          comments: result.comments,
          totalCount: result.totalCount,
          meta: result.meta,
        }));
      } else {
        log.warn({ videoId, error: result.error }, "comment extraction failed");
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: result.error || "Extraction failed" }));
      }
    } catch (err) {
      const isNoPanel = err.message.includes("no_active_panel_session");
      log.error({ err: err.message }, "extract-comments error");
      res.writeHead(isNoPanel ? 503 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, code: isNoPanel ? "no_active_panel_session" : "extension_error" }));
    }
  });
}

// ─── HTML → Markdown conversion ──────────────────────────────────────────────

function htmlToMarkdown(html) {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove(["nav", "header", "footer", "aside"]);

  // Turndown needs a DOM — parse the pruned HTML with JSDOM
  const dom = new JSDOM(html);
  return td.turndown(dom.window.document.body);
}

function handleExtractPageContent(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // No body needed — extracts from the active tab
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      log.info("requesting page content from extension");
      const result = await sendExtensionCommand({
        type: "get-page-content",
      }, 15000);

      if (result.success) {
        // Extension sends pruned HTML — convert to Markdown server-side
        const markdown = htmlToMarkdown(result.html);

        log.info({ htmlChars: result.html.length, mdChars: markdown.length, title: result.title }, "page content extracted");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          content: markdown,
          title: result.title,
          url: result.url,
        }));
      } else {
        log.warn({ error: result.error }, "page content extraction failed");
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: result.error || "Extraction failed" }));
      }
    } catch (err) {
      const isNoPanel = err.message.includes("no_active_panel_session");
      log.error({ err: err.message }, "extract-page-content error");
      res.writeHead(isNoPanel ? 503 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, code: isNoPanel ? "no_active_panel_session" : "extension_error" }));
    }
  });
}

function handleGetPlayerState(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { videoId } = JSON.parse(body);
      if (!videoId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "videoId is required" }));
        return;
      }

      log.info({ videoId }, "requesting player state from extension");
      const result = await sendExtensionCommand({
        type: "get-player-state",
        videoId,
      }, 5000);

      if (result.success) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          videoId: result.videoId,
          title: result.title,
          channel: result.channel,
          currentTime: result.currentTime,
          currentTimeFormatted: result.currentTimeFormatted,
          duration: result.duration,
          state: result.state,
          playbackRate: result.playbackRate,
        }));
      } else {
        log.warn({ videoId, error: result.error }, "player state request failed");
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: result.error || "Failed to get player state" }));
      }
    } catch (err) {
      const isNoPanel = err.message.includes("no_active_panel_session");
      log.error({ err: err.message }, "player-state error");
      res.writeHead(isNoPanel ? 503 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, code: isNoPanel ? "no_active_panel_session" : "extension_error" }));
    }
  });
}

// ─── HTTP Proxy + Context API ───────────────────────────────────────────────

const proxy = httpProxy.createProxyServer({
  target: `http://localhost:${TTYD_PORT}`,
  ws: true,
});

proxy.on("error", (err, _req, res) => {
  log.debug({ err: err.message }, "proxy error");
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

        // Write selection text to a file so Claude can read it directly
        // (the MCP notification text field gets truncated for large selections)
        const selectionFile = path.join(CONTEXT_DIR, "selection.txt");
        if (context.selection?.text) {
          fs.writeFileSync(selectionFile, context.selection.text);
          log.info({ lines: context.selection.lineCount, chars: context.selection.text.length }, "selection written to file");
        } else {
          // Clear the selection file when nothing is selected
          try { fs.unlinkSync(selectionFile); } catch {}
        }

        lastContext = context;

        // Push to Claude Code via MCP
        broadcastSelection(context);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log.warn({ err: err.message }, "invalid context JSON");
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
        log.debug({ videoId }, "transcript already cached");
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
      // Client-side extraction produces [MM:SS] timestamped lines — save as timed transcript too
      if (text.match(/^\[\d{2}:\d{2}\] /m)) {
        fs.writeFileSync(path.join(videoDir, "transcript_timed.txt"), text);
      }
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

      log.info({ videoId, chars: text.length, title, source: source || "client" }, "transcript cached");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, videoId, cached: true }));
    } catch (err) {
      log.error({ err: err.message }, "transcript error");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
  });
}

function handleFrame(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const { videoId, timestamp, image } = JSON.parse(body);

      if (!videoId || !image) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "videoId and image are required" }));
        return;
      }

      const totalSeconds = Math.floor(timestamp || 0);
      const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
      const ss = String(totalSeconds % 60).padStart(2, "0");
      const filename = `frame_${mm}_${ss}.jpg`;

      const videoDir = path.join(CACHE_DIR, videoId);
      fs.mkdirSync(videoDir, { recursive: true });

      // Strip data URL prefix if present
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(path.join(videoDir, filename), base64Data, "base64");

      const relativePath = `cache/youtube/${videoId}/${filename}`;
      log.info({ videoId, relativePath }, "frame captured");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: relativePath }));
    } catch (err) {
      log.error({ err: err.message }, "frame error");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
  });
}

const TMUX_SOCKET = process.env.BROWSERBUD_TMUX_SOCKET || "browserbud";

// Rejoin lines that were soft-wrapped by the application (Ink sends explicit \n
// for word-wrapping, so tmux treats every break as a hard newline).  We detect
// wraps by checking whether the *original* line filled most of the terminal width.
function unwrapText(text, width) {
  if (!width) return text;
  const lines = text.split("\n");
  if (lines.length <= 1) return text;

  const threshold = Math.floor(width * 0.85);
  const result = [lines[0]];
  let lastOrigLen = lines[0].length;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const prev = result[result.length - 1];

    // Empty line or previous was empty → paragraph break
    if (line === "" || prev === "") {
      result.push(line);
      lastOrigLen = line.length;
      continue;
    }

    // Current line starts a block-level element → keep separate
    if (/^(\s*[-*•+]\s|\s*\d+[.)]\s|\s*#+\s|```|---+|===+|\s*>\s)/.test(line)) {
      result.push(line);
      lastOrigLen = line.length;
      continue;
    }

    // Previous original line was near terminal width → likely a soft wrap
    if (lastOrigLen >= threshold && lastOrigLen <= width) {
      const trimmed = line.replace(/^\s+/, "");
      const needsSpace = !prev.endsWith(" ") && trimmed.length > 0;
      result[result.length - 1] = prev + (needsSpace ? " " : "") + trimmed;
      lastOrigLen = line.length;
    } else {
      result.push(line);
      lastOrigLen = line.length;
    }
  }

  return result.join("\n");
}

function handleClipboard(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  try {
    const text = execSync(`tmux -L ${TMUX_SOCKET} show-buffer 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 2000,
    });
    let width = 0;
    try {
      width = parseInt(execSync(`tmux -L ${TMUX_SOCKET} display -p '#{pane_width}' 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 2000,
      }).trim(), 10) || 0;
    } catch {}
    const result = width > 0 ? unwrapText(text, width) : text;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: result || "" }));
  } catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "" }));
  }
}

function handleBridgeLog(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      log.info({ bridge: payload }, "bridge event");
      res.writeHead(204);
      res.end();
    } catch (err) {
      log.warn({ err: err.message, body }, "bridge log parse failed");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
}

const server = http.createServer((req, res) => {
  const reqStart = Date.now();
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

  if (req.url === "/api/frame") {
    return handleFrame(req, res);
  }

  if (req.url === "/api/extract-transcript") {
    return handleExtractTranscript(req, res);
  }

  if (req.url === "/api/extract-comments") {
    return handleExtractComments(req, res);
  }

  if (req.url === "/api/player-state") {
    return handleGetPlayerState(req, res);
  }

  if (req.url === "/api/extract-page-content") {
    return handleExtractPageContent(req, res);
  }

  if (req.url === "/api/clipboard") {
    return handleClipboard(req, res);
  }

  if (req.url === "/api/bridge-log") {
    return handleBridgeLog(req, res);
  }

  if (req.url?.startsWith("/api/transcript-status/")) {
    const videoId = req.url.split("/api/transcript-status/")[1];
    if (!videoId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "videoId is required" }));
      return;
    }
    const videoDir = path.join(CACHE_DIR, videoId);
    const hasTimed = fs.existsSync(path.join(videoDir, "transcript_timed.txt"));
    const hasPlain = fs.existsSync(path.join(videoDir, "transcript.txt"));
    const hasMd = fs.existsSync(path.join(videoDir, "transcript.md"));
    const cached = hasTimed || hasPlain || hasMd;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ videoId, cached, hasTimed, hasPlain, hasMd }));
    return;
  }

  if (req.url === "/api/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      panelConnected: session.panelConnected,
      activeTabUrl: session.activeTabUrl,
      capabilities: session.capabilities,
    }));
    log.info({ url: req.url, ms: Date.now() - reqStart }, "http request");
    return;
  }

  // Serve the bridge script
  if (req.url === "/browserbud-bridge.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-cache",
    });
    res.end(BRIDGE_SCRIPT);
    log.info({ url: req.url, ms: Date.now() - reqStart }, "http request");
    return;
  }

  // Inject bridge script into ttyd's root HTML page
  if (req.url === "/" && req.method === "GET") {
    log.info("fetching ttyd HTML for bridge injection");
    http.get(`http://localhost:${TTYD_PORT}/`, (ttydRes) => {
      const chunks = [];
      ttydRes.on("data", (chunk) => chunks.push(chunk));
      ttydRes.on("end", () => {
        let html = Buffer.concat(chunks).toString();
        // Inject before </head> so it runs before ttyd's JS
        html = html.replace(
          "</head>",
          '  <script src="/browserbud-bridge.js"></script>\n  </head>',
        );
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(html);
        log.info({ url: "/", ms: Date.now() - reqStart }, "served ttyd HTML with bridge");
      });
      ttydRes.on("error", (err) => {
        log.warn({ err: err.message, ms: Date.now() - reqStart }, "failed to fetch ttyd HTML");
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway — ttyd not ready");
      });
    }).on("error", (err) => {
      log.warn({ err: err.message, ms: Date.now() - reqStart }, "failed to connect to ttyd");
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway — ttyd not ready");
    });
    return;
  }

  // Proxy to ttyd — log with duration
  log.info({ method: req.method, url: req.url }, "proxying to ttyd");
  res.on("finish", () => {
    log.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - reqStart }, "proxy response");
  });
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws/extension") {
    log.info("extension WebSocket upgrade");
    extensionWss.handleUpgrade(req, socket, head, (ws) => {
      extensionWss.emit("connection", ws, req);
    });
  } else {
    log.info({ url: req.url }, "ttyd WebSocket upgrade");
    proxy.ws(req, socket, head);
  }
});

// ─── Startup & Cleanup ─────────────────────────────────────────────────────

const mcpServer = startMcpServer();

server.listen(PROXY_PORT, () => {
  log.info({ proxyPort: PROXY_PORT, ttydPort: TTYD_PORT, ms: Date.now() - startTime }, "server ready — all services listening");
  bannerReady("proxy");
});

// Banner prints only after both proxy and Claude Code are ready
const bannerGates = new Set(["proxy", "claude"]);
const bannerDone = new Set();
let bannerPrinted = false;

function bannerReady(gate) {
  bannerDone.add(gate);
  if (bannerPrinted) return;
  for (const g of bannerGates) {
    if (!bannerDone.has(g)) return;
  }
  bannerPrinted = true;
  printBanner();
}

// Safety net: print banner after 30s even if Claude Code never connects
setTimeout(() => {
  if (!bannerPrinted) {
    log.warn("timed out waiting for all services — printing banner anyway");
    bannerPrinted = true;
    printBanner();
  }
}, 30000);

function printBanner() {
  const lines = [
    "",
    "  BrowserBud is running",
    "",
    `  Data directory:  ${DATA_DIR}`,
    `  Server:          http://localhost:${PROXY_PORT}`,
    "",
    "  Open the BrowserBud extension in Chrome and enter",
    "  this URL when prompted:",
    "",
    `    http://localhost:${PROXY_PORT}`,
    "",
    "  If running on a remote machine, use its public URL instead.",
    "  Press Ctrl+C to stop.",
    "",
  ];
  // Write directly to stdout to bypass pino formatting
  process.stdout.write(lines.join("\n") + "\n");
}

function cleanup() {
  removeLockFile();
  process.exit();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("exit", removeLockFile);
