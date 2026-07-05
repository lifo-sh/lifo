/**
 * tunnel.ts — tunnel command for the lifo CLI
 *
 * Connects to the tunnel server at wss://tunnel.lifo.sh/_tunnel via WebSocket
 * and proxies incoming HTTP requests to a local port on the host machine.
 *
 * Used in two ways:
 *   1. Host CLI:    `lifo tunnel 5173`   (handleTunnel)
 *   2. Inside shell: `tunnel 5173`       (createTunnelCommand → registered in shell)
 */

import * as http from 'node:http';
import type { Command } from '@lifo-sh/core';

const TUNNEL_SERVER = 'wss://tunnel.lifo.sh/_tunnel';

interface TunnelMessage {
	type: string;
	id?: string;
	wsId?: string;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
	data?: string;
	url?: string;
	subdomain?: string;
	message?: string;
}

async function loadWebSocket() {
	const wsModule = await import('ws');
	return wsModule.default;
}

function startTunnel(
	localPort: number,
	WS: typeof import('ws').default,
	write: (s: string) => void,
	writeErr: (s: string) => void,
	signal?: AbortSignal,
	token?: string,
): Promise<number> {
	const wsHeaders: Record<string, string> = {
		'x-local-port': String(localPort),
	};
	if (token) {
		wsHeaders.authorization = `Bearer ${token}`;
	}
	const ws = new WS(TUNNEL_SERVER, { headers: wsHeaders });

	// Local WebSocket connections for WS proxy: wsId -> WebSocket (to local server)
	const localWsConnections = new Map<string, InstanceType<typeof WS>>();

	function handleWsOpen(msg: TunnelMessage): void {
		const { wsId, path: wsPath, headers } = msg;
		if (!wsId || !wsPath) return;

		const localUrl = `ws://localhost:${localPort}${wsPath}`;
		write(`WS proxy: opening ${wsPath} (${wsId.slice(0, 8)})\n`);

		// Forward subprotocol (e.g. "vite-hmr") so the local server accepts the connection
		const protocols: string[] = [];
		if (headers?.['sec-websocket-protocol']) {
			protocols.push(...headers['sec-websocket-protocol'].split(',').map((s: string) => s.trim()));
		}

		const localWs = new WS(localUrl, protocols);
		localWsConnections.set(wsId, localWs);

		localWs.on('open', () => {
			if (ws.readyState === WS.OPEN) {
				ws.send(JSON.stringify({ type: 'ws-opened', wsId }));
			}
		});

		localWs.on('message', (data: Buffer) => {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (ws.readyState === WS.OPEN) {
				ws.send(JSON.stringify({
					type: 'ws-data',
					wsId,
					data: buf.toString('base64'),
				}));
			}
		});

		localWs.on('close', () => {
			localWsConnections.delete(wsId);
			if (ws.readyState === WS.OPEN) {
				ws.send(JSON.stringify({ type: 'ws-close', wsId }));
			}
		});

		localWs.on('error', (err: Error) => {
			writeErr(`WS proxy error (${wsId.slice(0, 8)}): ${err.message}\n`);
			localWsConnections.delete(wsId);
			if (ws.readyState === WS.OPEN) {
				ws.send(JSON.stringify({
					type: 'ws-error',
					wsId,
					message: err.message,
				}));
			}
		});
	}

	function handleWsData(msg: TunnelMessage): void {
		if (!msg.wsId || !msg.data) return;
		const localWs = localWsConnections.get(msg.wsId);
		if (localWs && localWs.readyState === WS.OPEN) {
			localWs.send(Buffer.from(msg.data, 'base64'));
		}
	}

	function handleWsClose(msg: TunnelMessage): void {
		if (!msg.wsId) return;
		const localWs = localWsConnections.get(msg.wsId);
		if (localWs) {
			localWsConnections.delete(msg.wsId);
			localWs.close();
		}
	}

	function forwardRequest(msg: TunnelMessage): void {
		const { id, method, path: reqPath, headers, body } = msg;

		const localHeaders: Record<string, string | number> = { ...headers };
		localHeaders.host = `localhost:${localPort}`;
		delete localHeaders['transfer-encoding'];

		const bodyBuf = body ? Buffer.from(body, 'base64') : null;
		if (bodyBuf && bodyBuf.length > 0) {
			localHeaders['content-length'] = bodyBuf.length;
		}

		write(`${method} ${reqPath}\n`);

		const proxyReq = http.request(
			{
				hostname: 'localhost',
				port: localPort,
				path: reqPath,
				method,
				headers: localHeaders as http.OutgoingHttpHeaders,
			},
			(proxyRes) => {
				const chunks: Buffer[] = [];
				proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
				proxyRes.on('end', () => {
					const responseHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
					delete responseHeaders['transfer-encoding'];

					const response = JSON.stringify({
						type: 'response',
						id,
						status: proxyRes.statusCode,
						headers: responseHeaders,
						body: Buffer.concat(chunks).toString('base64'),
					});

					if (ws.readyState === WS.OPEN) {
						ws.send(response);
					}
				});
			},
		);

		proxyReq.on('error', (err: Error) => {
			writeErr(`Local server error: ${err.message}\n`);
			const response = JSON.stringify({
				type: 'response',
				id,
				status: 502,
				headers: { 'content-type': 'text/plain' },
				body: Buffer.from(`Bad Gateway: ${err.message}`).toString('base64'),
			});
			if (ws.readyState === WS.OPEN) {
				ws.send(response);
			}
		});

		if (bodyBuf && bodyBuf.length > 0) {
			proxyReq.write(bodyBuf);
		}
		proxyReq.end();
	}

	let pingTimer: NodeJS.Timeout | null = null;
	return new Promise<number>((resolve) => {

		ws.on('open', () => {
			// Send a ping every 25s to keep the connection alive
			pingTimer = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.ping();
				}
			}, 25000);
			write('Connected to tunnel server\n');
		});

		ws.on('message', (data: Buffer) => {
			let msg: TunnelMessage;
			try { msg = JSON.parse(data.toString()); } catch { return; }

			if (msg.type === 'connected') {
				write(`\nPublic URL: ${msg.url}\n`);
				write(`Subdomain: ${msg.subdomain}\n`);
				write(`Forwarding to: http://localhost:${localPort}\n\n`);
			} else if (msg.type === 'request') {
				forwardRequest(msg);
			} else if (msg.type === 'ws-open') {
				handleWsOpen(msg);
			} else if (msg.type === 'ws-data') {
				handleWsData(msg);
			} else if (msg.type === 'ws-close') {
				handleWsClose(msg);
			} else if (msg.type === 'error') {
				writeErr(`Server error: ${msg.message}\n`);
			}
		});

		ws.on('close', () => {
			clearInterval(pingTimer);
			// Close all local WS connections
			for (const [, localWs] of localWsConnections) {
				localWs.close();
			}
			localWsConnections.clear();
			write('Disconnected from tunnel server\n');
			resolve(0);
		});

		ws.on('error', (err: Error) => {
			writeErr(`WebSocket error: ${err.message}\n`);
			resolve(1);
		});

		if (signal) {
			signal.addEventListener('abort', () => {
				write('\nShutting down tunnel...\n');
				ws.close();
			}, { once: true });
		}
	});
}

// ─── Host CLI: `lifo tunnel 5173` ────────────────────────────────────────────

export async function handleTunnel(port: number, token?: string): Promise<void> {
	let WS: typeof import('ws').default;
	try {
		WS = await loadWebSocket();
	} catch {
		console.error('Error: "ws" package is required. Run: pnpm add ws');
		process.exit(1);
	}

	const ac = new AbortController();
	process.on('SIGINT', () => ac.abort());
	process.on('SIGTERM', () => ac.abort());

	const code = await startTunnel(
		port,
		WS,
		(s) => process.stdout.write(s),
		(s) => process.stderr.write(s),
		ac.signal,
		token,
	);
	process.exit(code);
}

// ─── Shell command: `tunnel 5173` (inside lifo shell) ────────────────────────

export function createHostTunnelCommand(): Command {
	return async (ctx) => {
		const portArg = ctx.args[0];
		const port = portArg ? parseInt(portArg, 10) : NaN;

		if (!portArg || isNaN(port) || port < 1 || port > 65535) {
			ctx.stderr.write('Usage: tunnel <port>\n');
			ctx.stderr.write('Example: tunnel 5173\n');
			return 1;
		}

		let WS: typeof import('ws').default;
		try {
			WS = await loadWebSocket();
		} catch {
			ctx.stderr.write('tunnel: WebSocket library not available\n');
			return 1;
		}

		const token = ctx.env?.LIFO_AUTH_TOKEN || undefined;

		return startTunnel(
			port,
			WS,
			(s) => ctx.stdout.write(s),
			(s) => ctx.stderr.write(s),
			ctx.signal,
			token,
		);
	};
}
