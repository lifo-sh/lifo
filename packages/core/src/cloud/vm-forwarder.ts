/**
 * cloud/vm-forwarder.ts — the tunnel's far end inside a box: requests go to the
 * box's virtual servers (kernel.portRegistry), the same way previews and curl
 * reach them, and WebSocket upgrades are handed to the in-box server's 'upgrade'
 * listener as a raw socket.
 */

import type { VirtualRequestHandler } from '../kernel/index.js';
import { dispatchRequest, LIFO_HEADER } from '../kernel/network/dispatch.js';
import { VirtualUpgradeSocket } from '../kernel/network/ws-pipe.js';
import { getUpgradeHandlers } from '../node-compat/http.js';
import { Buffer } from '../node-compat/buffer.js';
import type { Headers, TunnelForwarder } from './tunnel-client.js';

/** Request headers as the in-box server should see them: addressed to localhost:<port>. */
export function localHeaders(headers: Headers, port: number, opts: { dropOrigin?: boolean } = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (v === undefined) continue;
		out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
	}
	// The visitor's Host is the public tunnel name. Dev servers (Vite's allowedHosts,
	// Next's dev origin check) reject unknown hosts, so present the request the way
	// a browser on this machine would send it.
	out.host = `localhost:${port}`;
	// Vite's HMR server compares Origin against its own host; the public origin
	// would be refused, so a piped socket arrives like a local non-browser client.
	if (opts.dropOrigin) delete out.origin;
	return out;
}

export function createVmForwarder(portRegistry: Map<number, VirtualRequestHandler>, port: number): TunnelForwarder {
	return {
		async http(req) {
			if (!portRegistry.has(port)) {
				const body = `Nothing is listening on port ${port} inside this Lifo box.\n`;
				return { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new TextEncoder().encode(body) };
			}
			const res = await dispatchRequest(portRegistry, port, {
				method: req.method,
				url: req.path,
				headers: localHeaders(req.headers, port),
				body: req.body.length ? req.body : undefined,
			});
			const headers: Headers = { ...res.headers };
			// Our own marker for synthesized errors (timeout, handler threw), not the app's.
			delete headers[LIFO_HEADER];
			return { status: res.statusCode, headers, body: res.bodyBytes };
		},

		upgrade(req, io) {
			const handler = getUpgradeHandlers(portRegistry).get(port);
			if (!handler) return null;
			const socket = new VirtualUpgradeSocket(
				(bytes) => io.send(bytes),
				() => io.close(),
			);
			const delivered = handler(
				{ method: 'GET', url: req.path, headers: localHeaders(req.headers, port, { dropOrigin: true }) },
				socket,
				new Uint8Array(0),
			);
			if (!delivered) {
				socket.destroy();
				return null;
			}
			return {
				write: (bytes) => socket.emit('data', Buffer.from(bytes)),
				close: () => socket.destroy(),
			};
		},
	};
}
