const http = require("http");
const httpProxy = require("http-proxy");

const TTYD_PORT = 7681;
const PROXY_PORT = 8080;

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

const server = http.createServer((req, res) => {
  // CORS headers for browser extension
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PROXY_PORT, () => {
  console.log(`Proxy server listening on port ${PROXY_PORT}, forwarding to ttyd on port ${TTYD_PORT}`);
});
