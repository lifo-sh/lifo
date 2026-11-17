/**
 * cloud/tunnel-client.ts — share a port through the lifo tunnel server.
 *
 * One client for every place `lifo tunnel` runs. The transport differs only in the
 * TunnelForwarder: inside a box it calls the box's virtual servers (vm-forwarder.ts),
 * on the host the CLI forwards to real localhost ports.
 *
 * Protocol (v2, JSON text frames; bodies and socket bytes are base64):
 *
 *   client → server  hello      { token, port, name?, client }
 *   server → client  ready      { url, name }               or  error { message } and close
 *   server → client  request    { id, method, path, headers, body }
 *   client → server  response   { id, status, headers, body }
 *   server → client  ws-upgrade { connId, path, headers }   raw pipe: the client's server answers
 *   both ways        ws-data    { connId, data }            raw socket bytes, not WebSocket frames
 *   both ways        ws-close   { connId }
 *
 * The token goes in the first message rather than a header because a browser's
 * WebSocket can't set headers. WebSockets are piped as raw bytes, so the local
 * server does its own handshake and frames (text vs binary) arrive unchanged.
 */

export type Headers = Record<string, string | string[] | undefined>;

export interface TunnelHttpRequest {
	method: string;
	path: string;
	headers: Headers;
	body: Uint8Array;
}

export interface TunnelHttpResponse {
	status: number;
	headers: Headers;
	body: Uint8Array;
}

/** One piped WebSocket: bytes from the visitor go to `write`, bytes back go to io.send. */
export interface TunnelPipe {
	write(bytes: Uint8Array): void;
	close(): void;
}

export interface TunnelForwarder {
	http(req: TunnelHttpRequest): Promise<TunnelHttpResponse>;
	/** Start a raw upgrade to the local server, or return null to refuse it. */
	upgrade(
		req: { path: string; headers: Headers },
		io: { send(bytes: Uint8Array): void; close(): void },
	): TunnelPipe | null;
}

export interface TunnelOptions {
	/** Tunnel server WebSocket URL (from /api/cli/config). */
	url: string;
	token: string;
	/**
	 * Called before each reconnect for a current token, for short-lived tokens (a page's
	 * `lifo_tab_` login). The first connect uses `token`.
	 */
	getToken?: () => Promise<string | null>;
	port: number;
	name?: string;
	/** e.g. "lifo-sh/0.11 (host)" or "lifo box (browser)". */
	client: string;
	forwarder: TunnelForwarder;
	signal?: AbortSignal;
	WebSocketImpl?: typeof WebSocket;
	onReady?(info: { url: string; name: string }): void;
	onRequest?(line: string): void;
	onStatus?(line: string): void;
}

const BIN_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i += BIN_CHUNK) {
		bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + BIN_CHUNK)));
	}
	return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64 || '');
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Errors the server sends that retrying won't fix. "Replaced" and "Stopped" matter most:
 * reconnecting after a newer tunnel took our name would take it back, and the two
 * would trade it forever.
 */
const FATAL = /invalid token|unauthori|taken|invalid name|reserved|forbidden|limit is|replaced|stopped/i;

/**
 * Runs until the signal aborts (exit 0) or the server refuses us (exit 1).
 * A dropped connection is retried with backoff, keeping the same name.
 */
export async function runTunnel(opts: TunnelOptions): Promise<number> {
	const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
	if (!WS) {
		opts.onStatus?.('tunnel: no WebSocket implementation available\n');
		return 1;
	}

	let name = opts.name;
	let token = opts.token;
	let attempt = 0;
	let first = true;
	while (!opts.signal?.aborted) {
		if (!first && opts.getToken) token = (await opts.getToken().catch(() => null)) || token;
		first = false;
		const result = await connectOnce(WS, { ...opts, token, name }, (assigned) => {
			// Keep the server-assigned name, so a reconnect gets the same URL back.
			name = assigned;
			attempt = 0;
		});
		if (opts.signal?.aborted) return 0;
		if (result.fatal) {
			opts.onStatus?.(`tunnel: ${result.message}\n`);
			return 1;
		}
		attempt++;
		if (attempt > 8) {
			opts.onStatus?.(`tunnel: giving up after ${attempt - 1} reconnects (${result.message})\n`);
			return 1;
		}
		const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1));
		opts.onStatus?.(`tunnel: ${result.message}; reconnecting in ${Math.round(wait / 1000)}s...\n`);
		await sleep(wait, opts.signal);
	}
	return 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(t);
			resolve();
		}, { once: true });
	});
}

interface Message {
	type: string;
	id?: string;
	connId?: string;
	method?: string;
	path?: string;
	headers?: Headers;
	body?: string;
	data?: string;
	url?: string;
	name?: string;
	message?: string;
}

function connectOnce(
	WS: typeof WebSocket,
	opts: TunnelOptions,
	onAssigned: (name: string) => void,
): Promise<{ fatal: boolean; message: string }> {
	return new Promise((resolve) => {
		let ws: WebSocket;
		try {
			ws = new WS(opts.url);
		} catch (e) {
			resolve({ fatal: true, message: `bad tunnel URL ${opts.url}: ${(e as Error).message}` });
			return;
		}
		const pipes = new Map<string, TunnelPipe>();
		let ready = false;
		let serverError = '';
		let settled = false;
		const finish = (r: { fatal: boolean; message: string }) => {
			if (settled) return;
			settled = true;
			for (const p of pipes.values()) p.close();
			pipes.clear();
			resolve(r);
		};

		const send = (msg: object) => {
			if (ws.readyState === 1) ws.send(JSON.stringify(msg));
		};

		const onAbort = () => {
			try {
				ws.close(1000, 'bye');
			} catch {
				/* already closed */
			}
			finish({ fatal: false, message: 'stopped' });
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });

		ws.addEventListener('open', () => {
			send({ type: 'hello', token: opts.token, port: opts.port, name: opts.name, client: opts.client });
		});

		ws.addEventListener('message', (ev: MessageEvent) => {
			let msg: Message;
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
			} catch {
				return;
			}
			switch (msg.type) {
				case 'ready':
					ready = true;
					onAssigned(msg.name!);
					opts.onReady?.({ url: msg.url!, name: msg.name! });
					break;
				case 'error':
					serverError = msg.message || 'refused by the tunnel server';
					break;
				case 'request':
					void handleRequest(msg);
					break;
				case 'ws-upgrade': {
					const connId = msg.connId!;
					const pipe = opts.forwarder.upgrade(
						{ path: msg.path || '/', headers: msg.headers || {} },
						{
							send: (bytes) => send({ type: 'ws-data', connId, data: bytesToBase64(bytes) }),
							close: () => {
								if (pipes.delete(connId)) send({ type: 'ws-close', connId });
							},
						},
					);
					if (pipe) {
						pipes.set(connId, pipe);
						opts.onRequest?.(`${'WS'.padEnd(7)}${msg.path}\n`);
					} else send({ type: 'ws-close', connId });
					break;
				}
				case 'ws-data':
					pipes.get(msg.connId!)?.write(base64ToBytes(msg.data || ''));
					break;
				case 'ws-close': {
					const p = pipes.get(msg.connId!);
					pipes.delete(msg.connId!);
					p?.close();
					break;
				}
			}
		});

		async function handleRequest(msg: Message) {
			const id = msg.id!;
			const started = Date.now();
			let res: TunnelHttpResponse;
			try {
				res = await opts.forwarder.http({
					method: msg.method || 'GET',
					path: msg.path || '/',
					headers: msg.headers || {},
					body: base64ToBytes(msg.body || ''),
				});
			} catch (e) {
				const text = `Bad gateway: ${(e as Error).message}`;
				res = { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new TextEncoder().encode(text) };
			}
			send({ type: 'response', id, status: res.status, headers: res.headers, body: bytesToBase64(res.body) });
			opts.onRequest?.(`${(msg.method || 'GET').padEnd(7)}${msg.path}  ${res.status}  ${Date.now() - started}ms\n`);
		}

		ws.addEventListener('close', (ev: CloseEvent) => {
			opts.signal?.removeEventListener('abort', onAbort);
			if (serverError) finish({ fatal: !ready || FATAL.test(serverError), message: serverError });
			else if (!ready && ev.code === 1006) finish({ fatal: false, message: `could not reach ${opts.url}` });
			else finish({ fatal: false, message: ev.reason || 'connection closed' });
		});
		ws.addEventListener('error', () => {
			/* 'close' follows and decides */
		});
	});
}
