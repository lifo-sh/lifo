/**
 * auth.ts — Bearer token middleware
 *
 * Reads ~/.lifo-token on every request (no caching) so login/logout
 * take effect immediately. If no token file exists, auth is skipped
 * (local-only mode — no remote auth server required).
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { readToken } from 'lifo-sh/auth';
import type { Middleware } from './types.js';
import { sendJson } from './router.js';

/** Auth middleware — validates Bearer token against ~/.lifo-token. */
export const authMiddleware: Middleware = (req, res, next) => {
  const expected = readToken();

  // No token file → local-only mode, skip auth
  if (!expected) {
    next();
    return;
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Missing or invalid Authorization header' });
    return;
  }

  const provided = authHeader.slice(7); // strip "Bearer "

  // Timing-safe comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    sendJson(res, 403, { error: 'Invalid token' });
    return;
  }

  next();
};
