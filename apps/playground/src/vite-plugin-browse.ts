import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleBrowseRequest } from 'lifo-pkg-agent/proxy';

/**
 * Dev-server middleware serving `/api/browse?url=<url>` for the `browser` command when the
 * playground runs on its own. Same handler and rules as the lifo.sh site's route (public
 * addresses only, GET only, 2 MB, 10 s, no cookies, rate-limited): lifo-pkg-agent/proxy.
 */
export function browsePlugin(): Plugin {
  return {
    name: 'lifo-browse',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        if (!req.url?.startsWith('/api/browse')) return next();
        void (async () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const webRes = await handleBrowseRequest(new Request(`http://localhost${req.url}`, { method: req.method, headers }), {
            clientKey: req.socket.remoteAddress ?? 'local',
          });
          res.statusCode = webRes.status;
          webRes.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await webRes.arrayBuffer()));
        })().catch((e) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        });
      });
    },
  };
}
