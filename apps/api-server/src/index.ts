/**
 * index.ts — lifo REST API server
 *
 * Exposes VM session management over HTTP + WebSocket.
 * Zero external dependencies — built on node:http with a custom router.
 *
 * Endpoints:
 *   GET    /health                  → { ok: true }
 *   POST   /api/sessions            → create VM session
 *   GET    /api/sessions            → list all sessions
 *   GET    /api/sessions/:id        → get session by ID
 *   DELETE /api/sessions/:id        → stop session
 *   WS     /api/sessions/:id/attach → terminal I/O (WebSocket)
 */

import * as http from 'node:http';
import { Router, sendJson } from './router.js';
import { corsMiddleware, handlePreflight } from './cors.js';
import { authMiddleware } from './auth.js';
import { createSession, getSessions, getSession, stopSession } from './handlers/sessions.js';
import { handleAttach } from './handlers/attach.js';

const PORT = parseInt(process.env.LIFO_API_PORT ?? '3001', 10);

// ── Router setup ──────────────────────────────────────────────────────────────

const router = new Router();

// Middlewares run in order: CORS → Auth
router.use(corsMiddleware);
router.use(authMiddleware);

// Health check (no auth — runs through middleware but /health is fine public)
router.get('/health', (_req, res) => {
  sendJson(res, 200, { ok: true });
});

// Session CRUD
router.post('/api/sessions', createSession);
router.get('/api/sessions', getSessions);
router.get('/api/sessions/:id', getSession);
router.delete('/api/sessions/:id', stopSession);

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    handlePreflight(req, res);
    return;
  }

  try {
    const matched = await router.handle(req, res);
    if (!matched) {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err: unknown) {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
});

// ── WebSocket upgrade ─────────────────────────────────────────────────────────

server.on('upgrade', (req, socket, _head) => {
  const urlPath = (req.url ?? '/').split('?')[0]!;

  // Only handle /api/sessions/:id/attach
  if (/^\/api\/sessions\/[^/]+\/attach$/.test(urlPath)) {
    handleAttach(req, socket);
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`lifo API server listening on http://localhost:${PORT}`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);
  console.log(`  Sessions: POST http://localhost:${PORT}/api/sessions`);
});
