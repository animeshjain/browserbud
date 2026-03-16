const http = require("http");
const fs = require("fs");
const path = require("path");
const httpProxy = require("http-proxy");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");

const TTYD_PORT = 7681;
const PROXY_PORT = 8080;
const CONTEXT_FILE = path.join(process.env.HOME, "browserbud", "context.json");

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
        handleMcpMessage(ws, msg);
      } catch (err) {
        console.error("[MCP] Bad message:", err.message);
      }
    });

    ws.on("close", () => {
      console.log("[MCP] Claude Code disconnected");
      connectedClients.delete(ws);
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
    writeLockFile();
    console.log(`[MCP] IDE server listening on 127.0.0.1:${mcpPort}`);
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

function writeLockFile() {
  const lockPath = path.join(IDE_DIR, `${mcpPort}.lock`);
  const lockData = {
    pid: process.pid,
    workspaceFolders: [path.join(process.env.HOME, "sessions")],
    ideName: "BrowserBud",
    transport: "ws",
    authToken,
  };
  fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
  console.log(`[MCP] Lock file written: ${lockPath}`);
}

function removeLockFile() {
  if (mcpPort) {
    const lockPath = path.join(IDE_DIR, `${mcpPort}.lock`);
    try {
      fs.unlinkSync(lockPath);
      console.log(`[MCP] Lock file removed: ${lockPath}`);
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
