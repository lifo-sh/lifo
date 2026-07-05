import type { Plugin } from 'vite';
import type { VirtualRequestHandler } from '@lifo-sh/core';

/**
 * Vite plugin that creates HTTP proxy endpoints for virtual Lifo ports
 *
 * This is like Docker's port forwarding (-p flag):
 *   docker run -p 5173:3000 mycontainer
 *
 * Allows accessing virtual servers at real URLs:
 *   http://localhost:5173/proxy/3000/ → Virtual port 3000
 */
export function lifoProxyPlugin(): Plugin {
  let portRegistry: Map<number, VirtualRequestHandler> | null = null;

  return {
    name: 'lifo-proxy',

    configureServer(server) {
      // Expose a global function for the app to register portRegistry
      (globalThis as any).__registerLifoPortRegistry = (registry: Map<number, VirtualRequestHandler>) => {
        portRegistry = registry;
        console.log('[Lifo Proxy] Port registry registered');

        // Log available ports
        if (registry.size > 0) {
          console.log('[Lifo Proxy] Virtual ports available:');
          for (const port of Array.from(registry.keys()).sort((a, b) => a - b)) {
            console.log(`  → http://localhost:${server.config.server.port || 5173}/proxy/${port}/`);
          }
        }
      };

      // Add middleware to handle proxy requests
      server.middlewares.use((req, res, next) => {
        // Match URLs like /proxy/3000/ or /proxy/3000/api/users
        const match = req.url?.match(/^\/proxy\/(\d+)(\/.*)?$/);

        if (!match) {
          return next();
        }

        const port = parseInt(match[1], 10);
        const path = match[2] || '/';

        console.log(`[Lifo Proxy] ${req.method} /proxy/${port}${path}`);

        if (!portRegistry) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'text/plain');
          res.end('Lifo port registry not initialized yet. Please wait for the app to load.\n');
          return;
        }

        const handler = portRegistry.get(port);

        if (!handler) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`No server running on virtual port ${port}\n\nAvailable ports: ${Array.from(portRegistry.keys()).join(', ') || 'none'}\n`);
          return;
        }

        // Collect request body
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString();

          // Create virtual request
          const virtualReq = {
            method: req.method || 'GET',
            url: path,
            headers: req.headers as Record<string, string>,
            body,
          };

          const virtualRes = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            body: '',
          };

          try {
            // Call the virtual server handler (synchronous)
            handler(virtualReq, virtualRes);

            console.log(`[Lifo Proxy] ${virtualRes.statusCode} ${req.method} /proxy/${port}${path}`);

            // Send response
            res.statusCode = virtualRes.statusCode;

            // Set headers
            for (const [key, value] of Object.entries(virtualRes.headers)) {
              res.setHeader(key, value);
            }

            res.end(virtualRes.body);
          } catch (error) {
            console.error(`[Lifo Proxy] Error:`, error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        });

        req.on('error', (error) => {
          console.error(`[Lifo Proxy] Request error:`, error);
          res.statusCode = 500;
          res.end('Request error\n');
        });
      });

      console.log('[Lifo Proxy] Middleware registered');
      console.log('[Lifo Proxy] Access virtual servers at: http://localhost:' + (server.config.server.port || 5173) + '/proxy/PORT/');
    },
  };
}
