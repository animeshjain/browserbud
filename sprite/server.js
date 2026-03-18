const http = require("http");
const fs = require("fs");
const path = require("path");
const httpProxy = require("http-proxy");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const pino = require("pino");

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
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(process.env.HOME, "browse");
const CONTEXT_DIR = path.join(DATA_DIR, "context");
const CONTEXT_FILE = path.join(CONTEXT_DIR, "current.json");
const CACHE_DIR = path.join(DATA_DIR, "cache", "youtube");

// ─── Terminal Bridge Script ─────────────────────────────────────────────────
// Injected into ttyd's HTML page. Captures the ttyd WebSocket and listens for
// postMessage from the extension side panel to type text into the terminal.

const BRIDGE_SCRIPT = `
(function() {
  var ttydSocket = null;
  var NativeWebSocket = window.WebSocket;

  // Subclass WebSocket to capture ttyd's connection
  class BrowserBudWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (url.toString().includes('/ws')) {
        ttydSocket = this;
        console.log('[BrowserBud] Captured ttyd WebSocket');
        // Re-capture on reconnect
        this.addEventListener('close', function() {
          if (ttydSocket === this) ttydSocket = null;
        });
      }
    }
  }
  window.WebSocket = BrowserBudWebSocket;

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.type !== 'browserbud:type-text') return;
    if (!ttydSocket || ttydSocket.readyState !== WebSocket.OPEN) {
      console.warn('[BrowserBud] No active ttyd WebSocket');
      return;
    }
    var text = event.data.text || '';
    if (!text) return;

    // ttyd protocol: string frame, '0' prefix = CMD_INPUT
    ttydSocket.send('0' + text);
    console.log('[BrowserBud] Typed into terminal:', text);
  });
})();
`;

// ─── IDE MCP WebSocket Server ───────────────────────────────────────────────

const IDE_DIR = path.join(process.env.HOME, ".claude", "ide");
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

  // Map browser context to selection_changed format
  const displayText = site && title ? `${site}: ${title}` : "";
  const filePath = url || "";

  return {
    notification: JSON.stringify({
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

const extensionWss = new WebSocketServer({ noServer: true });

extensionWss.on("connection", (ws) => {
  log.info("extension connected");
  extensionWs = ws;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      log.debug({ type: msg.type }, "extension message received");
      if (msg.type === "extract-transcript-result" && msg.requestId) {
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
    log.info("extension disconnected");
    if (extensionWs === ws) extensionWs = null;
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension disconnected"));
      pendingRequests.delete(id);
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

function sendExtensionCommand(command) {
  return new Promise((resolve, reject) => {
    if (!extensionWs || extensionWs.readyState !== extensionWs.OPEN) {
      reject(new Error("Extension not connected"));
      return;
    }

    const requestId = uuidv4();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Timeout waiting for extension response"));
    }, 15000);

    pendingRequests.set(requestId, { resolve, reject, timer });
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
      log.error({ err: err.message }, "extract-transcript error");
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
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
});

function cleanup() {
  removeLockFile();
  process.exit();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("exit", removeLockFile);
