/**
 * handlers/attach.ts — WebSocket-to-Unix-socket bridge for VM terminal I/O
 *
 * Bridges a WebSocket connection to the daemon's Unix socket, using the same
 * JSON protocol as the CLI attach command:
 *   { type: "input",  data: string }   — client → VM
 *   { type: "resize", cols: n, rows: n } — client → VM
 *   { type: "output", data: string }   — VM → client
 */

import * as net from 'node:net';
import type * as http from 'node:http';
import * as crypto from 'node:crypto';
import { readSession } from 'lifo-sh/session';
import { readToken } from 'lifo-sh/auth';
import { upgradeWebSocket, encodeFrame, attachFrameReader } from '../websocket.js';

/**
 * Authenticate the WebSocket upgrade request.
 * Checks Authorization header first, then ?token= query param (browser fallback).
 * Returns true if auth passes (or no token file exists).
 */
function authenticateWs(req: http.IncomingMessage): boolean {
  const expected = readToken();
  if (!expected) return true; // no token file → local-only mode

  // Try Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const provided = authHeader.slice(7);
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return true;
    }
  }

  // Try ?token= query param (browsers can't set headers on WebSocket)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const tokenParam = url.searchParams.get('token');
  if (tokenParam) {
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(tokenParam);
    if (expectedBuf.length === providedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return true;
    }
  }

  return false;
}

/**
 * Handle WebSocket upgrade for /api/sessions/:id/attach.
 * Called from the HTTP server's 'upgrade' event.
 */
export function handleAttach(
  req: http.IncomingMessage,
  socket: net.Socket,
): void {
  // Authenticate
  if (!authenticateWs(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Extract session ID from URL: /api/sessions/:id/attach
  const urlPath = (req.url ?? '/').split('?')[0]!;
  const segments = urlPath.split('/').filter(Boolean);
  // Expected: ["api", "sessions", "<id>", "attach"]
  if (segments.length !== 4 || segments[0] !== 'api' || segments[1] !== 'sessions' || segments[3] !== 'attach') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const sessionId = segments[2]!;
  const session = readSession(sessionId);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Perform WebSocket handshake
  const ws = upgradeWebSocket(req, socket);
  if (!ws) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Connect to the daemon's Unix socket
  const unixSocket = net.createConnection(session.socketPath);

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    unixSocket.destroy();
    ws.destroy();
  }

  // Unix socket → WebSocket: forward each line as a WS text frame
  let unixBuffer = '';
  unixSocket.on('data', (chunk: Buffer) => {
    unixBuffer += chunk.toString();
    const lines = unixBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    unixBuffer = lines.pop()!;
    for (const line of lines) {
      if (line) {
        try {
          ws.write(encodeFrame(line));
        } catch {
          cleanup();
        }
      }
    }
  });

  unixSocket.on('close', cleanup);
  unixSocket.on('error', cleanup);

  // WebSocket → Unix socket: forward each message as a JSON line
  attachFrameReader(
    ws,
    (message: string) => {
      // Forward the message as-is (it's already JSON from the client)
      unixSocket.write(message + '\n');
    },
    cleanup,
  );
}
