import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import os from "os";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let port = process.env.PORT || 3005;
  let host = process.env.HOST || '0.0.0.0';
  let tunnelPort = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--port=')) {
      tunnelPort = parseInt(args[i].slice('--port='.length), 10);
    } else if (args[i] === '--port' && args[i + 1]) {
      tunnelPort = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--server-port=')) {
      port = parseInt(args[i].slice('--server-port='.length), 10);
    } else if (args[i] === '--server-port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i].startsWith('--host=')) {
      host = args[i].slice('--host='.length);
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Lifo Tunnel Server

Usage: node server.js [options]

Options:
  --port <number>        Port to tunnel to inside Lifo (e.g., 5173)
  --server-port <number> Port for tunnel server to listen on (default: 3005)
  --host <address>       Host address to bind to (default: 0.0.0.0)
  -h, --help            Show this help

Examples:
  # Tunnel to port 5173, server listens on 3005
  node server.js --port 5173

  # Custom server port
  node server.js --port 5173 --server-port 8080

Environment Variables:
  PORT         Server listen port (default: 3005)
  HOST         Server bind address (default: 0.0.0.0)
`);
      process.exit(0);
    }
  }

  return { port, host, tunnelPort };
}

const { port: PORT, host: HOST, tunnelPort: TUNNEL_PORT } = parseArgs();

const pendingRequests = new Map();
// Browser vite-hmr sockets parked at the relay, fed by in-VM hmr-broadcast messages
// (fallback path — used only when the VM refuses raw ws piping)
const hmrSockets = new Set();
// Raw-piped browser WebSocket connections, by connId: browser bytes ⟷ tunnel
// messages ⟷ in-VM WebSocket server (real end-to-end frame protocol).
const wsPipes = new Map();
let tunnelClient = null;

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // Handle WebSocket upgrade separately
  if (req.headers.upgrade === "websocket") {
    return;
  }

  console.log(`[HTTP] ${req.method} ${req.url}`);

  // CORS proxy: /_cors?url=<encoded>. The browser VM can't fetch non-CORS hosts
  // (e.g. api.expo.dev, which create-expo-app hits for SDK versions); this
  // fetches server-side and returns with permissive CORS headers. This is the
  // local stand-in for a hosted Lifo proxy service. Not tunneled — answered
  // directly by the relay, so it works with no tunnel client connected.
  if (req.url.startsWith("/_cors")) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "*",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    const target = new URL(req.url, "http://localhost").searchParams.get("url");
    if (!target) { res.writeHead(400, cors); res.end("missing url param"); return; }
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: { accept: req.headers["accept"] || "*/*", "user-agent": req.headers["user-agent"] || "lifo" },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        ...cors,
        "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, cors);
      res.end("cors proxy error: " + e.message);
    }
    return;
  }

  // Check if tunnel client is connected
  if (!tunnelClient || tunnelClient.readyState !== 1) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Tunnel client not connected");
    return;
  }

  // Generate unique request ID
  const requestId = crypto.randomUUID();

  // Read request body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("base64");

  // Create promise for the response
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request timeout"));
    }, 30000);

    pendingRequests.set(requestId, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });

  // Prepend tunnel port to URL if specified
  let tunnelUrl = req.url;
  if (TUNNEL_PORT) {
    // Add port prefix for path-based routing: /5173/path
    tunnelUrl = `/${TUNNEL_PORT}${req.url}`;
  }

  // Send request to tunnel client
  const tunnelRequest = {
    type: "request",
    requestId,
    method: req.method,
    url: tunnelUrl,
    headers: req.headers,
    body,
  };

  tunnelClient.send(JSON.stringify(tunnelRequest));

  try {
    // Wait for response from client
    const response = await responsePromise;

    // Log response details
    try {
      console.log(`\n[HTTP] ========== RESPONSE ==========`);
      console.log(`[HTTP] Status: ${response.statusCode}`);
      console.log(`[HTTP] Request: ${req.method} ${req.url}`);
      console.log(`[HTTP] Headers:`, JSON.stringify(response.headers, null, 2));

      if (response.body) {
        const responseBody = Buffer.from(response.body, "base64").toString();
        console.log(`[HTTP] Body Length: ${responseBody.length} bytes`);
        console.log(`[HTTP] Body:`, responseBody.length > 1000 ? responseBody.substring(0, 1000) + '...' : responseBody);
      } else {
        console.log(`[HTTP] Body: <empty>`);
      }
      console.log(`[HTTP] ==============================\n`);
    } catch (logError) {
      console.error(`[HTTP] Logging error:`, logError);
    }

    // Send response back to original requester
    res.writeHead(response.statusCode, response.headers);
    res.end(Buffer.from(response.body, "base64"));
  } catch (error) {
    console.error("[HTTP] Error:", error.message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Tunnel error: " + error.message);
  }
});

// Create WebSocket server in noServer mode: upgrades are routed manually so
// browser WebSocket connections (e.g. Vite HMR, subprotocol "vite-hmr") can
// be piped RAW through the tunnel to the in-VM WebSocket server, while the
// tunnel client itself (no subprotocol) is handled by the ws library.
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => (protocols.has("vite-hmr") ? "vite-hmr" : false),
});

server.on("upgrade", (req, socket, head) => {
  const proto = req.headers["sec-websocket-protocol"] || "";
  const path = (req.url || "/").split("?")[0];
  // The in-VM tunnel client connects to the ROOT path with no subprotocol.
  // Every other WebSocket is an application socket that must be piped RAW to
  // the VM's own ws server — Metro's Fast Refresh channels /hot and /message
  // (React Native uses no subprotocol), Vite HMR ("vite-hmr"), etc. The old
  // code only piped "vite-hmr" and treated everything else as a tunnel client,
  // so a phone's /hot socket hijacked `tunnelClient` and never reached Metro.
  const isTunnelClient = (path === "/" || path === "/_tunnel") && !proto.includes("vite-hmr");
  if (isTunnelClient) {
    console.log(`[WS] tunnel client upgrade (${path})`);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    console.log(`[WS] raw-pipe app socket → VM (${path})`);
    rawPipeUpgrade(req, socket, head);
  }
});

/**
 * Pipe a browser WebSocket connection raw through the tunnel: the in-VM
 * server (Vite's bundled ws) performs the actual handshake and speaks the
 * real frame protocol with the browser. The relay only moves bytes.
 */
function rawPipeUpgrade(req, socket, head) {
  if (!tunnelClient || tunnelClient.readyState !== 1) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  const connId = crypto.randomUUID();
  const url = TUNNEL_PORT ? `/${TUNNEL_PORT}${req.url}` : req.url;
  const pipe = { socket, req, head, receivedBytes: 0 };
  wsPipes.set(connId, pipe);
  console.log(`\n◆ Raw WS pipe opened (${req.url}) → VM`);

  tunnelClient.send(JSON.stringify({
    type: "ws-upgrade",
    connId,
    url,
    method: req.method,
    headers: req.headers,
  }));
  if (head && head.length > 0) {
    tunnelClient.send(JSON.stringify({ type: "ws-data", connId, data: head.toString("base64") }));
  }
  socket.on("data", (chunk) => {
    if (tunnelClient && tunnelClient.readyState === 1) {
      tunnelClient.send(JSON.stringify({ type: "ws-data", connId, data: chunk.toString("base64") }));
    }
  });
  const closePipe = () => {
    if (wsPipes.delete(connId) && tunnelClient && tunnelClient.readyState === 1) {
      tunnelClient.send(JSON.stringify({ type: "ws-close", connId }));
    }
  };
  socket.on("close", closePipe);
  socket.on("error", closePipe);
}

/** Fallback: park a browser HMR socket fed by in-VM hmr-broadcast messages. */
function parkHmrClient(ws) {
  console.log(`\n○ Browser HMR client parked (${hmrSockets.size + 1} total) — VM refused raw WS`);
  hmrSockets.add(ws);
  try { ws.send(JSON.stringify({ type: "connected" })); } catch {}
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch {}
  });
  ws.on("close", () => hmrSockets.delete(ws));
  ws.on("error", () => hmrSockets.delete(ws));
}

wss.on("connection", (ws) => {
  console.log(`\n✓ Tunnel client connected!`);
  if (TUNNEL_PORT) {
    console.log(`  Ready to serve port ${TUNNEL_PORT}\n`);
  } else {
    console.log(`  Ready for path-based routing\n`);
  }
  tunnelClient = ws;

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "response") {
        const pending = pendingRequests.get(message.requestId);
        if (pending) {
          pendingRequests.delete(message.requestId);
          pending.resolve({
            statusCode: message.statusCode,
            headers: message.headers,
            body: message.body,
          });
        }
      } else if (message.type === "hmr-broadcast") {
        // In-VM dev server pushed an HMR payload — fan out to parked browser
        // HMR sockets (fallback path when raw WS piping is unavailable).
        const json = JSON.stringify(message.payload);
        if (hmrSockets.size > 0) {
          console.log(`[HMR] broadcast to ${hmrSockets.size} parked client(s): ${json.slice(0, 80)}`);
          for (const sock of hmrSockets) {
            try { sock.send(json); } catch {}
          }
        }
      } else if (message.type === "ws-data") {
        const pipe = wsPipes.get(message.connId);
        if (pipe) {
          pipe.receivedBytes += message.data.length;
          pipe.socket.write(Buffer.from(message.data, "base64"));
        }
      } else if (message.type === "ws-close") {
        const pipe = wsPipes.get(message.connId);
        if (pipe) {
          wsPipes.delete(message.connId);
          if (pipe.receivedBytes === 0) {
            // VM refused the upgrade before answering (e.g. older core, or a
            // plain HTTP server on that port) — fall back to parking the
            // browser socket and serving hmr-broadcast payloads.
            wss.handleUpgrade(pipe.req, pipe.socket, pipe.head, (client) => parkHmrClient(client));
          } else {
            pipe.socket.destroy();
          }
        }
      }
    } catch (error) {
      console.error("[WebSocket] Error parsing message:", error);
    }
  });

  ws.on("close", () => {
    console.log(`\n✗ Tunnel client disconnected`);
    console.log(`  Waiting for reconnection...\n`);
    if (tunnelClient === ws) {
      tunnelClient = null;
    }

    // Reject all pending requests
    for (const [requestId, pending] of pendingRequests.entries()) {
      pending.reject(new Error("Tunnel client disconnected"));
      pendingRequests.delete(requestId);
    }

    // Tear down raw WS pipes — their VM endpoint is gone
    for (const [connId, pipe] of wsPipes.entries()) {
      wsPipes.delete(connId);
      try { pipe.socket.destroy(); } catch {}
    }
  });

  ws.on("error", (error) => {
    console.error("[WebSocket] Error:", error);
  });
});

server.listen(PORT, HOST, () => {
  const networkInterfaces = os.networkInterfaces();
  const addresses = [];

  for (const iface of Object.values(networkInterfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        addresses.push(alias.address);
      }
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Lifo Tunnel Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (TUNNEL_PORT) {
    console.log(`✓ Server listening on ${HOST}:${PORT}`);
    console.log(`✓ Tunneling to port ${TUNNEL_PORT}\n`);
    console.log(`Access your app at:`);
    console.log(`  Local:   http://localhost:${PORT}`);
    if (addresses.length > 0) {
      addresses.forEach(addr => {
        console.log(`  Network: http://${addr}:${PORT}`);
      });
    }
    console.log(`\nAll requests will be forwarded to port ${TUNNEL_PORT} inside Lifo`);
  } else {
    console.log(`✓ Server listening on ${HOST}:${PORT}`);
    console.log(`\nAccess your app at:`);
    console.log(`  Local:   http://localhost:${PORT}`);
    if (addresses.length > 0) {
      addresses.forEach(addr => {
        console.log(`  Network: http://${addr}:${PORT}`);
      });
    }
    console.log(`\nPath-based routing mode: http://localhost:${PORT}/PORT/path`);
    console.log(`Example: http://localhost:${PORT}/5173/ → port 5173 inside Lifo`);
  }

  console.log(`\nWebSocket: ws://${HOST}:${PORT}`);
  console.log(`\nWaiting for tunnel client to connect...`);
  console.log(`Run inside Lifo: tunnel\n`);
});
