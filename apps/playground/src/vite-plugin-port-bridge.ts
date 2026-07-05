import type { Plugin } from 'vite';
import type { Kernel } from '@lifo-sh/core';

/**
 * Vite plugin to bridge virtual ports to the dev server
 * Allows accessing virtual HTTP servers via /api/proxy/:port/*
 */
export function portBridgePlugin(): Plugin {
	// Global reference to the kernel (will be set by main.ts)
	let getKernel: (() => Kernel | null) | null = null;

	return {
		name: 'port-bridge',
		configureServer(server) {
			// Expose a global function to set the kernel
			(globalThis as any).__setLifoKernel = (kernelGetter: () => Kernel | null) => {
				getKernel = kernelGetter;
			};

			// Add middleware to handle proxy requests
			server.middlewares.use((req, res, next) => {
				const url = req.url;
				if (!url || !url.startsWith('/api/proxy/')) {
					return next();
				}

				// Parse URL: /api/proxy/:port/*
				const match = url.match(/^\/api\/proxy\/(\d+)(\/.*)?$/);
				if (!match) {
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/plain');
					res.end('Bad Request: Invalid proxy URL format. Use /api/proxy/:port/path\n');
					return;
				}

				const virtualPort = parseInt(match[1], 10);
				const path = match[2] || '/';

				// Get kernel instance
				const kernel = getKernel?.();
				if (!kernel) {
					res.statusCode = 503;
					res.setHeader('Content-Type', 'text/plain');
					res.end('Service Unavailable: Kernel not initialized\n');
					return;
				}

				// Check if port has a handler
				const handler = kernel.portRegistry.get(virtualPort);
				if (!handler) {
					res.statusCode = 502;
					res.setHeader('Content-Type', 'text/plain');
					res.end(`Bad Gateway: No service running on virtual port ${virtualPort}\n`);
					return;
				}

				// Collect request body
				const chunks: Buffer[] = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					const body = Buffer.concat(chunks).toString('utf-8');

					// Create virtual request
					const virtualReq = {
						method: req.method || 'GET',
						url: path,
						headers: req.headers as Record<string, string>,
						body,
					};

					// Create virtual response
					const virtualRes = {
						statusCode: 200,
						headers: {} as Record<string, string>,
						body: '',
					};

					try {
						// Call the virtual handler
						handler(virtualReq, virtualRes);

						// Send response
						res.statusCode = virtualRes.statusCode;
						for (const [key, value] of Object.entries(virtualRes.headers)) {
							res.setHeader(key, value);
						}
						res.end(virtualRes.body);
					} catch (error) {
						res.statusCode = 500;
						res.setHeader('Content-Type', 'text/plain');
						res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}\n`);
					}
				});

				req.on('error', (error) => {
					res.statusCode = 500;
					res.setHeader('Content-Type', 'text/plain');
					res.end(`Request Error: ${error.message}\n`);
				});
			});

			console.log('[PortBridge] Middleware installed - virtual ports accessible at /api/proxy/:port/*');
		},
	};
}
