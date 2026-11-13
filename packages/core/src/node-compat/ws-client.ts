/**
 * WebSocket clients in a box: `http.request` / `https.request` with `Upgrade: websocket`.
 *
 * Libraries like `ws` (bundled in playwright-core, puppeteer, socket.io-client) open a WebSocket
 * by sending an HTTP upgrade and then speaking RFC 6455 frames over the raw socket. A box has no
 * raw sockets to the outside, and its http client is fetch, which can't upgrade. So the upgrade
 * is answered here:
 *
 * - To a server in the same box (localhost, a port with an upgrade handler): the request goes to
 *   that server, which runs its own handshake; the two sides' bytes are passed straight through.
 * - Anywhere else: the host's own WebSocket (the browser's, Node's, workerd's) connects, a 101
 *   response is made up for the library (with the accept key it expects), and frames are
 *   translated both ways: the library's masked client frames become host WebSocket messages, and
 *   host messages become unmasked server frames for the library. The host WebSocket handles ping
 *   and pong itself; the library's pings are answered here.
 *
 * Headers can't be set on a browser WebSocket (only sub-protocols), so outside a box's own
 * servers only the URL and `Sec-WebSocket-Protocol` travel; in Node the other headers are passed.
 */

import { Buffer } from './buffer.js';
import { createHash } from './crypto.js';
import { VirtualUpgradeSocket } from '../kernel/network/ws-pipe.js';
import { FrameDecoder, OPCODE, splitHandshake } from '../kernel/network/ws-frame.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Bytes for a socket stand-in. A real socket buffers until someone reads; an EventEmitter drops
 * what arrives before the first 'data' listener (the library on the other side may attach it a
 * tick after the upgrade). So hold them until there is a listener, in order.
 */
const held = new WeakMap<VirtualUpgradeSocket, { queue: Uint8Array[]; since: number }>();
function deliver(sock: VirtualUpgradeSocket, bytes: Uint8Array): void {
	if (sock.destroyed) return;
	// Always a later turn, like bytes from a network: the sender is often still inside its own
	// write() when the other side answers, and libraries (ws) don't expect re-entrant data.
	let h = held.get(sock);
	if (h) {
		h.queue.push(bytes);
		return;
	}
	h = { queue: [bytes], since: Date.now() };
	held.set(sock, h);
	const flush = () => {
		const cur = held.get(sock);
		if (!cur || sock.destroyed) return void held.delete(sock);
		if (sock.listenerCount('data') === 0) {
			if (Date.now() - cur.since < 30_000) setTimeout(flush, 2);
			return;
		}
		held.delete(sock);
		for (const b of cur.queue) if (!sock.destroyed) sock.emit('data', Buffer.from(b));
	};
	queueMicrotask(flush);
}

/** One server→client frame (unmasked), FIN set. */
export function encodeServerFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const len = payload.length;
	const headLen = len < 126 ? 2 : len < 65536 ? 4 : 10;
	const out = new Uint8Array(headLen + len);
	out[0] = 0x80 | opcode;
	if (len < 126) out[1] = len;
	else if (len < 65536) {
		out[1] = 126;
		out[2] = len >> 8;
		out[3] = len & 0xff;
	} else {
		out[1] = 127;
		const hi = Math.floor(len / 2 ** 32);
		const lo = len >>> 0;
		out[2] = hi >>> 24;
		out[3] = (hi >>> 16) & 0xff;
		out[4] = (hi >>> 8) & 0xff;
		out[5] = hi & 0xff;
		out[6] = lo >>> 24;
		out[7] = (lo >>> 16) & 0xff;
		out[8] = (lo >>> 8) & 0xff;
		out[9] = lo & 0xff;
	}
	out.set(payload, headLen);
	return out;
}

function closePayload(code: number, reason: string): Uint8Array {
	const r = textEncoder.encode(reason).subarray(0, 123);
	const out = new Uint8Array(2 + r.length);
	out[0] = code >> 8;
	out[1] = code & 0xff;
	out.set(r, 2);
	return out;
}

/** What ClientRequest gives us: where it goes, its headers, and how to report back. */
export interface UpgradeRequest {
	url: string; // ws:// or wss://
	host: string;
	port: number | undefined;
	path: string;
	headers: Record<string, string>; // lower-case keys
	emit(event: string, ...args: unknown[]): boolean;
	makeResponse(status: number, statusText: string, headers: Record<string, string>): unknown;
	/** Keep the node run going while the connection is open; returns the release. */
	hold?: () => () => void;
}

type HostWebSocket = {
	readyState: number;
	protocol: string;
	binaryType: string;
	send(data: string | ArrayBufferLike | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
};
type HostWebSocketCtor = new (url: string, protocols?: string | string[] | Record<string, unknown>) => HostWebSocket;

/** A server in this box takes the upgrade: pass bytes straight through after its handshake. */
export function upgradeInBox(req: UpgradeRequest, handler: (r: { method: string; url: string; headers: Record<string, string> }, socket: unknown, head: Uint8Array) => boolean): boolean {
	let handshakeDone = false;
	let pending = new Uint8Array(0);
	// clientSock: what the client library holds; serverSock: what the box's server holds.
	const clientSock: VirtualUpgradeSocket = new VirtualUpgradeSocket(
		(bytes) => deliver(serverSock, bytes),
		() => serverSock.destroy(),
	);
	const serverSock: VirtualUpgradeSocket = new VirtualUpgradeSocket(
		(bytes) => {
			if (handshakeDone) return deliver(clientSock, bytes);
			const merged = new Uint8Array(pending.length + bytes.length);
			merged.set(pending);
			merged.set(bytes, pending.length);
			const split = splitHandshake(merged);
			if (!split) {
				pending = merged;
				return;
			}
			handshakeDone = true;
			const lines = split.header.split('\r\n');
			const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(lines[0] || '');
			const headers: Record<string, string> = {};
			for (const line of lines.slice(1)) {
				const i = line.indexOf(':');
				if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
			}
			const status = m ? Number(m[1]) : 500;
			const res = req.makeResponse(status, m?.[2] ?? '', headers);
			if (status === 101) {
				const release = req.hold?.();
				if (release) clientSock.once('close', release);
				req.emit('upgrade', res, clientSock, Buffer.from(split.rest));
			}
			else req.emit('response', res);
		},
		() => clientSock.destroy(),
	);
	return handler({ method: 'GET', url: req.path, headers: req.headers }, serverSock, new Uint8Array(0));
}

/** Anywhere else: the host's WebSocket, with frames translated for the client library. */
export function upgradeViaHost(req: UpgradeRequest, WS: HostWebSocketCtor | undefined = (globalThis as { WebSocket?: HostWebSocketCtor }).WebSocket): void {
	if (!WS) {
		setTimeout(() => req.emit('error', new Error('WebSockets out of this box need a host with a WebSocket client')), 0);
		return;
	}
	const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
	const inNode = typeof window === 'undefined' && typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string';
	let ws: HostWebSocket;
	try {
		if (inNode) {
			// Node's WebSocket (undici) takes headers too; the hop-by-hop and handshake ones are its own.
			const skip = new Set(['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']);
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers)) if (!skip.has(k)) headers[k] = v;
			ws = new WS(req.url, { protocols, headers });
		} else {
			ws = protocols.length ? new WS(req.url, protocols) : new WS(req.url);
		}
	} catch (e) {
		setTimeout(() => req.emit('error', e), 0);
		return;
	}
	ws.binaryType = 'arraybuffer';

	const decoder = new FrameDecoder();
	let fragments: Uint8Array[] = [];
	let fragmentOpcode = 0;
	let opened = false;
	let closed = false;

	const socket: VirtualUpgradeSocket = new VirtualUpgradeSocket(
		(bytes) => {
			// The library's (masked) client frames.
			for (const f of decoder.push(bytes)) {
				if (f.opcode === OPCODE.ping) {
					deliver(socket, encodeServerFrame(OPCODE.pong, f.payload));
					continue;
				}
				if (f.opcode === OPCODE.pong) continue;
				if (f.opcode === OPCODE.close) {
					const code = f.payload.length >= 2 ? (f.payload[0] << 8) | f.payload[1] : 1000;
					const reason = f.payload.length > 2 ? textDecoder.decode(f.payload.subarray(2)) : '';
					closed = true;
					try {
						ws.close(code === 1005 || code < 1000 ? 1000 : code, reason);
					} catch {
						ws.close();
					}
					// Echo the close, as a server would, then end the socket.
					deliver(socket, encodeServerFrame(OPCODE.close, f.payload));
					setTimeout(() => socket.destroy(), 0);
					return;
				}
				if (f.opcode !== OPCODE.continuation) fragmentOpcode = f.opcode;
				fragments.push(f.payload);
				if (!f.fin) continue;
				let total = 0;
				for (const p of fragments) total += p.length;
				const full = new Uint8Array(total);
				let off = 0;
				for (const p of fragments) {
					full.set(p, off);
					off += p.length;
				}
				fragments = [];
				if (ws.readyState === 1) ws.send(fragmentOpcode === OPCODE.text ? textDecoder.decode(full) : full);
			}
		},
		() => {
			if (!closed) {
				closed = true;
				try {
					ws.close();
				} catch {
					/* already closing */
				}
			}
		},
	);

	ws.addEventListener('open', () => {
		opened = true;
		const release = req.hold?.();
		if (release) socket.once('close', release);
		const key = req.headers['sec-websocket-key'] || '';
		const headers: Record<string, string> = {
			upgrade: 'websocket',
			connection: 'Upgrade',
			'sec-websocket-accept': createHash('sha1').update(key + GUID).digest('base64') as string,
		};
		if (ws.protocol) headers['sec-websocket-protocol'] = ws.protocol;
		req.emit('upgrade', req.makeResponse(101, 'Switching Protocols', headers), socket, Buffer.alloc(0));
	});
	ws.addEventListener('message', (ev) => {
		const d = ev.data;
		const frame =
			typeof d === 'string'
				? encodeServerFrame(OPCODE.text, textEncoder.encode(d))
				: encodeServerFrame(OPCODE.binary, d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength));
		deliver(socket, frame);
	});
	ws.addEventListener('close', (ev) => {
		if (!opened) {
			req.emit('error', Object.assign(new Error(`WebSocket connection to ${req.url.replace(/\?.*$/, '')} failed`), { code: 'ECONNREFUSED' }));
			return;
		}
		if (!closed) {
			closed = true;
			// 1005/1006 are reserved: they can't appear in a close frame.
			const code = ev.code && ev.code !== 1005 && ev.code !== 1006 ? ev.code : 1000;
			deliver(socket, encodeServerFrame(OPCODE.close, closePayload(code, ev.reason ?? '')));
			setTimeout(() => socket.destroy(), 0);
		}
	});
	ws.addEventListener('error', () => {
		/* 'close' follows and reports it */
	});
}
