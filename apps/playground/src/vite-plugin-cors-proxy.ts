import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCorsProxy } from './lib/cors-proxy';

/**
 * Dev-server middleware serving `/_cors?url=<encoded>` — the same-origin CORS
 * proxy the browser VM uses to reach non-CORS hosts (api.expo.dev). In
 * production the Next.js site serves the identical endpoint (a route + rewrite
 * to /_cors), so the playground behaves the same shipped or standalone, with
 * no separate tunnel relay required.
 */
export function corsProxyPlugin(): Plugin {
  return {
    name: 'lifo-cors-proxy',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        if (!req.url || !req.url.startsWith('/_cors')) return next();
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const webReq = new Request('http://localhost' + req.url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          });
          const webRes = await handleCorsProxy(webReq);
          res.statusCode = webRes.status;
          webRes.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await webRes.arrayBuffer()));
        })().catch((e) => {
          res.statusCode = 500;
          res.end('cors proxy error: ' + (e instanceof Error ? e.message : String(e)));
        });
      });
    },
  };
}
