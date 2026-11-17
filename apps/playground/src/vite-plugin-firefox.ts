import type { Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';

/**
 * Dev-only Firefox for the "Browser agent" example when the playground runs on its own:
 *
 *   /firefox/*          the patched Firefox-in-WebAssembly release, from LIFO_FIREFOX_DIR or the
 *                       website checkout's public/firefox (website: `pnpm fetch:firefox`)
 *   /api/wisp-token     { url } of the relay below, so the example asks the same way it does on
 *                       lifo.sh (where the site mints a login-bound token for the tunnel server)
 *   /wisp-local/        a WISP relay without login. The dev server listens on localhost only;
 *                       it still refuses loopback/private addresses and ports other than 80/443.
 *
 * Also sends Document-Isolation-Policy on the playground's HTML, so Chrome isolates the page
 * (Firefox needs SharedArrayBuffer) without COOP/COEP breaking the other examples.
 */
export function firefoxPlugin(): Plugin {
  const dir = [process.env.LIFO_FIREFOX_DIR, path.resolve(__dirname, '../../../../website/public/firefox')].find(
    (d): d is string => !!d && fs.existsSync(path.join(d, 'index.html')),
  );
  wisp.options.allow_loopback_ips = false;
  wisp.options.allow_private_ips = false;
  wisp.options.allow_udp_streams = false;
  wisp.options.port_whitelist = [80, 443];
  const ISOLATE = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Document-Isolation-Policy': 'isolate-and-require-corp',
  };
  return {
    name: 'lifo-firefox',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/wisp-local/')) return;
        req.url = '/wisp/';
        wisp.routeRequest(req, socket, head);
      });
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/api/wisp-token') {
          if (!dir) {
            res.statusCode = 503;
            res.end(JSON.stringify({ error: 'Firefox is not staged: run `pnpm fetch:firefox` in the website, or set LIFO_FIREFOX_DIR' }));
            return;
          }
          const host = req.headers.host ?? 'localhost:5173';
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ url: `ws://${host}/wisp-local/` }));
          return;
        }
        if (url.pathname.startsWith('/firefox/')) {
          if (!dir) return next();
          const file = path.normalize(path.join(dir, decodeURIComponent(url.pathname.slice('/firefox/'.length)) || 'index.html'));
          if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
          const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webp': 'image/webp' }[path.extname(file)];
          for (const [k, v] of Object.entries(ISOLATE)) res.setHeader(k, v);
          res.setHeader('content-type', type ?? 'application/octet-stream');
          fs.createReadStream(file).pipe(res);
          return;
        }
        // The app's HTML: isolate it in Chrome (Document-Isolation-Policy) so Firefox can run.
        const accept = req.headers.accept ?? '';
        if (req.method === 'GET' && accept.includes('text/html')) res.setHeader('Document-Isolation-Policy', 'isolate-and-credentialless');
        next();
      });
    },
  };
}
