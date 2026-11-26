import http from "node:http";
import net from "node:net";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);
const backendInternal = new URL(process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000");

function forwardWebSocketUpgrade(req, clientSocket, head) {
  clientSocket.setNoDelay(true);
  const backendPort = backendInternal.port
    ? parseInt(backendInternal.port, 10)
    : backendInternal.protocol === "https:"
      ? 443
      : 80;

  const upstream = net.connect(backendPort, backendInternal.hostname, () => {
    upstream.setNoDelay(true);
    const headerLines = [`${req.method || "GET"} ${req.url || "/ws"} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      const v = req.rawHeaders[i + 1];
      if (k.toLowerCase() === "host") {
        headerLines.push(`Host: ${backendInternal.host}`);
      } else {
        headerLines.push(`${k}: ${v}`);
      }
    }
    headerLines.push("", "");
    upstream.write(headerLines.join("\r\n"));
    if (head && head.length > 0) {
      upstream.write(head);
    }
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  const cleanup = () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };

  upstream.on("error", cleanup);
  clientSocket.on("error", cleanup);
}

const server = http.createServer();

// Intercept /ws WebSocket upgrades before Next.js's internal HMR upgrade listener touches the socket
const origEmit = server.emit.bind(server);
server.emit = (event, ...args) => {
  if (event === "upgrade") {
    const [req, socket, head] = args;
    const pathname = (req?.url || "").split("?")[0];
    if (pathname === "/ws" || pathname.startsWith("/ws/")) {
      forwardWebSocketUpgrade(req, socket, head);
      return true;
    }
  }
  return origEmit(event, ...args);
};

const app = next({ dev, hostname, port, httpServer: server });
const handle = app.getRequestHandler();

await app.prepare();

server.on("request", (req, res) => {
  handle(req, res);
});

server.listen(port, hostname, () => {
  console.log(
    `> RelayChat Web + WS proxy ready on http://${hostname}:${port} (API -> ${backendInternal.origin})`
  );
});
