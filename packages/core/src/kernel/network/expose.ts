/**
 * expose.ts — publish an in-VM port on a real host port.
 *
 * The VM's ports are objects in a `Map`, not sockets, so nothing outside the
 * process can reach them: in a browser that's what the service worker or the
 * blob preview is for, and over the network it's what a tunnel is for. On a host
 * with real sockets (the CLI) neither is needed — bind a port and forward.
 *
 * ```ts
 * import * as http from 'node:http';
 *
 * const exposed = await exposePort(sandbox.kernel.portRegistry, {
 *   vmPort: 3000,
 *   hostPort: 3000,      // omit for an OS-assigned port
 *   http,
 * });
 * // → curl http://127.0.0.1:3000/  reaches the server inside the VM
 * await exposed.close();
 * ```
 *
 * `http` is INJECTED rather than imported, the same way `NativeFsProvider` takes
 * its `fs` module. `@lifo-sh/core` is bundled for the browser, and a static
 * `node:http` import would either break that build or have to be externalised;
 * passing the module keeps this file environment-agnostic and directly testable.
 *
 * HTTP goes through `dispatchRequest`, so slow servers, timeouts and unbound
 * ports behave exactly as they do for every other transport.
 *
 * WebSockets are forwarded at the BYTE level: the client's socket is handed to
 * the in-VM server, which performs its own RFC 6455 handshake and framing. So
 * there is no `Sec-WebSocket-Accept` to compute here and no frame to parse — the
 * bytes the in-VM `ws` writes are already exactly what the client expects.
 */

import { dispatchRequest } from './dispatch.js';
import { VirtualUpgradeSocket } from './ws-pipe.js';
import { getUpgradeHandlers } from '../../node-compat/http.js';
import type { VirtualRequestHandler } from '../index.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The slice of `node:http` this needs. Structural, so the real module satisfies it. */
export interface HostHttpModule {
	createServer(handler: (req: any, res: any) => void): HostHttpServer;
}

export interface HostHttpServer {
	listen(port: number, host: string, cb: () => void): void;
	close(cb?: (err?: Error) => void): void;
	on(event: string, listener: (...args: any[]) => void): void;
	address(): { port: number } | string | null;
}

export interface ExposePortOptions {
	/** The in-VM port to publish. */
	vmPort: number;
	/** Host port to bind. Omit or 0 for an OS-assigned free port. */
	hostPort?: number;
	/**
	 * Interface to bind. Defaults to `127.0.0.1` — loopback only, deliberately:
	 * the VM runs untrusted project code, so publishing it to every interface is
	 * something a caller should have to ask for.
	 */
	host?: string;
	/** `node:http` (or a compatible module). */
	http: HostHttpModule;
	/** Passed through to `dispatchRequest` (default 120s). */
	timeoutMs?: number;
	/** Optional hook for logging each forwarded request. */
	onRequest?: (method: string, url: string, status: number) => void;
}

export interface ExposedPort {
	/** The port actually bound (resolved, if the OS assigned it). */
	readonly hostPort: number;
	/** Convenience URL for the bound address. */
	readonly url: string;
	/** Stop listening. Resolves once the host server has closed. */
	close(): Promise<void>;
}

/**
 * Bind `hostPort` on the host and forward everything to the in-VM server on
 * `vmPort`.
 *
 * Does NOT require the in-VM server to be listening yet — a request that arrives
 * first gets `dispatchRequest`'s `404` with `x-lifo: no-server`, so a forwarder
 * can be set up before the dev server starts. Rejects if the host port is already
 * in use.
 */
export function exposePort(
	portRegistry: Map<number, VirtualRequestHandler>,
	options: ExposePortOptions,
): Promise<ExposedPort> {
	const { vmPort, hostPort = 0, host = '127.0.0.1', http, timeoutMs, onRequest } = options;

	return new Promise<ExposedPort>((resolve, reject) => {
		const server = http.createServer((req: any, res: any) => {
			const chunks: Uint8Array[] = [];
			req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
			req.on('end', () => {
				let body: Uint8Array | undefined;
				if (chunks.length > 0) {
					let total = 0;
					for (const c of chunks) total += c.length;
					body = new Uint8Array(total);
					let off = 0;
					for (const c of chunks) { body.set(c, off); off += c.length; }
				}

				const headers: Record<string, string> = {};
				for (const [key, value] of Object.entries(req.headers ?? {})) {
					headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
				}

				dispatchRequest(
					portRegistry,
					vmPort,
					{ method: req.method ?? 'GET', url: req.url ?? '/', headers, body },
					{ timeoutMs },
				).then((vRes) => {
					onRequest?.(req.method ?? 'GET', req.url ?? '/', vRes.statusCode);
					res.writeHead(vRes.statusCode, vRes.headers);
					res.end(vRes.bodyBytes);
				}).catch((error: unknown) => {
					// dispatchRequest resolves rather than throws, so reaching here means
					// something in this forwarder failed — report it as a 502 rather than
					// leaving the client hanging.
					const message = error instanceof Error ? error.message : String(error);
					res.writeHead(502, { 'content-type': 'text/plain' });
					res.end(`Bad gateway forwarding to in-VM port ${vmPort}: ${message}`);
				});
			});
		});

		// WebSocket (and any other) upgrade: forward raw bytes both ways and let the
		// in-VM server own the handshake, so nothing here has to speak RFC 6455.
		server.on('upgrade', (req: any, socket: any, head: Uint8Array) => {
			const upgradeHandler = getUpgradeHandlers(portRegistry).get(vmPort);
			if (!upgradeHandler) {
				socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
				return;
			}

			const vmSocket = new VirtualUpgradeSocket(
				(bytes) => { try { socket.write(bytes); } catch { /* client vanished */ } },
				() => { try { socket.destroy(); } catch { /* already gone */ } },
			);

			socket.on('data', (chunk: Uint8Array) => vmSocket.emit('data', chunk));
			socket.on('close', () => vmSocket.destroy());
			socket.on('error', () => vmSocket.destroy());

			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(req.headers ?? {})) {
				headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
			}

			const delivered = upgradeHandler(
				{ method: req.method ?? 'GET', url: req.url ?? '/', headers },
				vmSocket,
				head && head.length > 0 ? head : new Uint8Array(0),
			);
			if (!delivered) {
				socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
				vmSocket.destroy();
			}
		});

		server.on('error', (error: Error) => reject(error));

		server.listen(hostPort, host, () => {
			const address = server.address();
			const bound = typeof address === 'object' && address ? address.port : hostPort;
			resolve({
				hostPort: bound,
				url: `http://${host}:${bound}`,
				close() {
					return new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()));
					});
				},
			});
		});
	});
}
