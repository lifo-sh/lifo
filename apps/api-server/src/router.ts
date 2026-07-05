/**
 * router.ts — lightweight pattern-matching HTTP router
 *
 * Supports :param captures (e.g. /api/sessions/:id) and middleware chains.
 * No external dependencies — just string matching.
 */

import type * as http from 'node:http';
import type { ApiRequest, RouteHandler, Middleware, RouteParams } from './types.js';

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

/** Try to match a URL path against a route pattern with :param support. */
function matchRoute(segments: string[], pattern: string[]): RouteParams | null {
  if (segments.length !== pattern.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i]!.startsWith(':')) {
      params[pattern[i]!.slice(1)] = segments[i]!;
    } else if (pattern[i] !== segments[i]) {
      return null;
    }
  }
  return params;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: Middleware[] = [];

  /** Register a middleware that runs before every route handler. */
  use(mw: Middleware): void {
    this.middlewares.push(mw);
  }

  get(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: 'GET', pattern, segments: pattern.split('/').filter(Boolean), handler });
  }

  post(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: 'POST', pattern, segments: pattern.split('/').filter(Boolean), handler });
  }

  delete(pattern: string, handler: RouteHandler): void {
    this.routes.push({ method: 'DELETE', pattern, segments: pattern.split('/').filter(Boolean), handler });
  }

  /** Dispatch an incoming request through middlewares then the matched route. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const method = req.method ?? 'GET';
    const urlPath = (req.url ?? '/').split('?')[0]!;
    const segments = urlPath.split('/').filter(Boolean);

    // Find matching route
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchRoute(segments, route.segments);
      if (!params) continue;

      // Augment request with params
      const apiReq = req as ApiRequest;
      apiReq.params = params;

      // Run middleware chain
      let stopped = false;
      for (const mw of this.middlewares) {
        let continued = false;
        await mw(apiReq, res, () => { continued = true; });
        if (!continued) { stopped = true; break; }
      }
      if (stopped) return true;

      // Run handler
      await route.handler(apiReq, res);
      return true;
    }

    return false; // no route matched
  }
}

/** Send a JSON response with the given status code. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Read and parse the request body as JSON. Returns undefined for empty bodies. */
export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) { resolve(undefined); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
