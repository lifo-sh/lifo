/**
 * handlers/sessions.ts — REST CRUD for VM sessions
 *
 * POST   /api/sessions      — create a new VM daemon
 * GET    /api/sessions       — list all sessions
 * GET    /api/sessions/:id   — get a single session
 * DELETE /api/sessions/:id   — stop a session
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listSessions, readSession, deleteSession } from 'lifo-sh/session';
import { startDaemon } from 'lifo-sh/daemon';
import { sendJson, readJsonBody } from '../router.js';
import type { ApiRequest } from '../types.js';
import type * as http from 'node:http';

/**
 * Resolve the CLI entry point for daemon spawning.
 * The daemon subprocess needs to run the lifo CLI script (not the API server).
 */
function getCliEntryPath(): string {
  // In a pnpm monorepo, lifo-sh's dist/index.js is the CLI entry point.
  // Resolve from the lifo-sh package.
  try {
    // Try to find the CLI dist relative to the lifo-sh package
    const sessionModulePath = require.resolve('lifo-sh/session');
    const distDir = path.dirname(sessionModulePath);
    const cliEntry = path.join(distDir, 'index.js');
    if (fs.existsSync(cliEntry)) return cliEntry;
  } catch {
    // require.resolve may not work in ESM — try import.meta.resolve
  }

  // Fallback: navigate from this file's location in the monorepo
  // apps/api-server/dist/index.js → packages/cli/dist/index.js
  const monoRoot = path.resolve(import.meta.dirname, '../../..');
  const fallback = path.join(monoRoot, 'packages/cli/dist/index.js');
  if (fs.existsSync(fallback)) return fallback;

  throw new Error('Could not locate lifo CLI entry point. Build lifo-sh first.');
}

/** POST /api/sessions — create a new VM daemon session. */
export async function createSession(req: ApiRequest, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await readJsonBody(req);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  // Determine mount path
  let mountPath: string;
  if (typeof body.mountPath === 'string' && body.mountPath) {
    mountPath = path.resolve(body.mountPath);
    if (!fs.existsSync(mountPath)) {
      sendJson(res, 400, { error: `Mount path does not exist: ${mountPath}` });
      return;
    }
    if (!fs.statSync(mountPath).isDirectory()) {
      sendJson(res, 400, { error: `Mount path is not a directory: ${mountPath}` });
      return;
    }
  } else {
    mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-'));
  }

  const port = typeof body.port === 'number' ? body.port : undefined;

  try {
    const cliEntry = getCliEntryPath();
    const id = await startDaemon(mountPath, port, cliEntry);
    const session = readSession(id);
    if (!session) {
      sendJson(res, 500, { error: 'Session created but metadata not found' });
      return;
    }
    sendJson(res, 201, { ...session, alive: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
  }
}

/** GET /api/sessions — list all sessions. */
export function getSessions(_req: ApiRequest, res: http.ServerResponse): void {
  const sessions = listSessions();
  sendJson(res, 200, sessions);
}

/** GET /api/sessions/:id — get a single session. */
export function getSession(req: ApiRequest, res: http.ServerResponse): void {
  const { id } = req.params;
  const session = readSession(id!);
  if (!session) {
    sendJson(res, 404, { error: `Session not found: ${id}` });
    return;
  }

  let alive = false;
  try {
    process.kill(session.pid, 0);
    alive = true;
  } catch {
    // process not running
  }

  sendJson(res, 200, { ...session, alive });
}

/** DELETE /api/sessions/:id — stop a session. */
export function stopSession(req: ApiRequest, res: http.ServerResponse): void {
  const { id } = req.params;
  const session = readSession(id!);
  if (!session) {
    sendJson(res, 404, { error: `Session not found: ${id}` });
    return;
  }

  try {
    process.kill(session.pid, 'SIGTERM');
  } catch {
    // already dead — still clean up files
  }

  deleteSession(id!);
  sendJson(res, 200, { ok: true, id });
}
