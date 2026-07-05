/**
 * cors.ts — permissive CORS headers for local development
 */

import type * as http from 'node:http';
import type { Middleware } from './types.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** Sets CORS headers on every response. Handles OPTIONS preflight with 204. */
export const corsMiddleware: Middleware = (_req, res, next) => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  next();
};

/** Handle OPTIONS preflight — return 204 with CORS headers, end response. */
export function handlePreflight(_req: http.IncomingMessage, res: http.ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  res.writeHead(204);
  res.end();
}
