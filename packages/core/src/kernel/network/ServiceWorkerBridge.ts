/**
 * ServiceWorkerBridge — page-side half of the service-worker transport.
 *
 * The service worker (apps/playground/public/sw.js) intercepts requests from
 * app clients and forwards them over a MessageChannel using the same message
 * shapes as the tunnel relay ({type:'request'} → {type:'response'}). This
 * class answers them from the kernel's portRegistry, exactly like
 * WebSocketTunnel does for relay traffic — it is a sibling transport for
 * environments where a local relay process isn't available.
 */

import type { VirtualRequestHandler } from '../index.js';
import type { VirtualResponseWithDone } from '../../node-compat/http.js';
import { getUpgradeHandlers } from '../../node-compat/http.js';
import { EventEmitter } from '../../node-compat/events.js';
import { encodeFrame, FrameDecoder, OPCODE, splitHandshake } from './ws-frame.js';

interface SwRequestMessage {
	type: 'request';
	requestId: string;
	port: number;
	method: string;
	url: string;
	headers: Record<string, string>;
	/** base64-encoded request body ('' when absent) */
	body: string;
}

interface SwWsOpenMessage {
	type: 'ws-open';
	connId: string;
	port: number;
	url: string;
	protocol: string;
}

interface SwWsSendMessage {
	type: 'ws-send';
	connId: string;
	/** base64 payload */
	data: string;
	binary: boolean;
}

interface SwWsCloseMessage {
	type: 'ws-close';
	connId: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function randomMask(out: Uint8Array): void {
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		crypto.getRandomValues(out);
	} else {
		// Deterministic fallback (non-browser hosts / tests) — masking value is
		// irrelevant to correctness, only presence of the mask bit matters.
		for (let i = 0; i < out.length; i++) out[i] = (i * 41 + 7) & 0xff;
	}
}

/**
 * Socket stand-in for a browser WebSocket piped through the service worker.
 * Same role as the tunnel's VirtualUpgradeSocket: the in-VM ws server (Vite
 * HMR) reads/writes RFC 6455 bytes here; the bridge frames/deframes to the
 * message-level protocol the browser shim speaks.
 */
class SwUpgradeSocket extends EventEmitter {
	readable = true;
	writable = true;
	destroyed = false;
	remoteAddress = '127.0.0.1';
	_readableState = { endEmitted: false, ended: false };
	_writableState = { finished: false, errorEmitted: false, ended: false };

	constructor(private onServerBytes: (bytes: Uint8Array) => void, private onClosed: () => void) {
		super();
	}

	write(data: string | Uint8Array, encodingOrCb?: unknown, cb?: () => void): boolean {
		const callback = typeof encodingOrCb === 'function' ? (encodingOrCb as () => void) : cb;
		if (!this.destroyed) {
			this.onServerBytes(typeof data === 'string' ? textEncoder.encode(data) : data);
		}
		callback?.();
		return true;
	}

	end(data?: string | Uint8Array): void {
		if (data !== undefined && !this.destroyed) this.write(data);
		this.destroy();
	}

	destroy(): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.readable = false;
		this.writable = false;
		this._readableState.endEmitted = true;
		this._writableState.finished = true;
		this.onClosed();
		this.emit('close');
		return this;
	}

	read(): null { return null; }
	unshift(): void {}
	setTimeout(): this { return this; }
	setNoDelay(): this { return this; }
	setKeepAlive(): this { return this; }
	pause(): this { return this; }
	resume(): this { return this; }
	cork(): void {}
	uncork(): void {}
}

interface WsConnection {
	socket: SwUpgradeSocket;
	decoder: FrameDecoder;
	handshakeDone: boolean;
	/** Reassembly buffer for fragmented data frames. */
	fragments: Uint8Array[];
	fragmentOpcode: number;
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** The bridge that answers the SW's reconnection requests (last connect wins). */
let activeBridge: ServiceWorkerBridge | null = null;
let swListenerInstalled = false;

export class ServiceWorkerBridge {
	private port: MessagePort | null = null;
	private wsConns = new Map<string, WsConnection>();
	private registration: ServiceWorkerRegistration | null = null;

	constructor(private portRegistry: Map<number, VirtualRequestHandler>) {}

	/**
	 * Register the service worker and hand it a fresh MessageChannel.
	 *
	 * Service workers are killed when idle (~30s), which drops the channel and
	 * all their in-memory state. We can't detect that from here, so the SW
	 * re-requests a host when it wakes without one ({type:'lifo-need-host'}) and
	 * we also reconnect on controllerchange — the page re-announces on demand.
	 */
	/**
	 * @param swUrl   Path to the worker script. When the app is served under a
	 *                base path (e.g. /playground/), pass the base-prefixed URL
	 *                so the file resolves.
	 * @param scope   Desired control scope. Defaults to '/' so previews at
	 *                /_sw/<port>/ (and the inner apps' root-absolute asset URLs)
	 *                are intercepted even when the outer app lives under a base
	 *                path. A worker served from a subdirectory needs the host to
	 *                send `Service-Worker-Allowed: /` for the broader scope to
	 *                be granted.
	 */
	async connect(swUrl = '/sw.js', scope = '/'): Promise<boolean> {
		if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
		try {
			this.registration = await navigator.serviceWorker.register(swUrl, { scope });
			await navigator.serviceWorker.ready;
			activeBridge = this;

			if (!swListenerInstalled) {
				swListenerInstalled = true;
				navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
					if ((event.data as { type?: string })?.type === 'lifo-need-host') {
						void activeBridge?.reconnect();
					}
				});
				navigator.serviceWorker.addEventListener('controllerchange', () => {
					void activeBridge?.reconnect();
				});
			}

			return this.reconnect();
		} catch (error) {
			console.warn('[lifo-sw] service worker registration failed:', error);
			return false;
		}
	}

	/** (Re)establish the MessageChannel to the (possibly restarted) service worker. */
	async reconnect(): Promise<boolean> {
		const controller = navigator.serviceWorker.controller ?? this.registration?.active ?? null;
		if (!controller) return false;
		const channel = new MessageChannel();
		this.attach(channel.port1);
		controller.postMessage({ type: 'lifo-connect' }, [channel.port2]);
		return true;
	}

	/** Wire a MessagePort directly (used by connect() and by tests). */
	attach(port: MessagePort): void {
		this.detach();
		// A reconnect means the SW restarted; any prior WS connections are dead
		// (their frame state lived in the old SW). Vite's client will reopen.
		for (const conn of this.wsConns.values()) conn.socket.destroy();
		this.wsConns.clear();
		this.port = port;
		port.onmessage = (event: MessageEvent) => {
			const msg = event.data as { type?: string };
			if (!msg) return;
			switch (msg.type) {
				case 'request': void this.handleRequest(msg as SwRequestMessage); break;
				case 'ws-open': this.handleWsOpen(msg as unknown as SwWsOpenMessage); break;
				case 'ws-send': this.handleWsSend(msg as unknown as SwWsSendMessage); break;
				case 'ws-close': this.handleWsClose(msg as unknown as SwWsCloseMessage); break;
			}
		};
		if (typeof port.start === 'function') port.start();
	}

	detach(): void {
		if (this.port) {
			try { this.port.close(); } catch { /* already closed */ }
			this.port = null;
		}
	}

	private respondText(requestId: string, statusCode: number, headers: Record<string, string>, text: string): void {
		this.respond(requestId, statusCode, headers, textEncoder.encode(text));
	}

	private respond(requestId: string, statusCode: number, headers: Record<string, string>, bytes: Uint8Array): void {
		// Transfer the ArrayBuffer (zero-copy) instead of base64 — critical for
		// large binary responses like PGlite's ~12MB wasm.
		const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
			? bytes.buffer
			: bytes.slice().buffer;
		this.port?.postMessage({ type: 'response', requestId, statusCode, headers, bodyBuffer: buf }, [buf]);
	}

	private async handleRequest(message: SwRequestMessage): Promise<void> {
		const { requestId, port, method, url, headers, body } = message;

		const handler = this.portRegistry.get(port);
		if (!handler) {
			this.respondText(requestId, 404, { 'content-type': 'text/plain' }, `No server listening on port ${port}`);
			return;
		}

		const vReq = {
			method,
			url,
			headers,
			body: body ? textDecoder.decode(base64ToBytes(body)) : '',
		};
		const vRes: VirtualResponseWithDone = {
			statusCode: 200,
			headers: {} as Record<string, string>,
			body: '',
		};

		try {
			handler(vReq, vRes);
			if (vRes._donePromise) {
				const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25000));
				const result = await Promise.race([vRes._donePromise.then(() => 'done' as const), timeout]);
				if (result === 'timeout') {
					this.respondText(requestId, 504, { 'content-type': 'text/plain' }, `Gateway timeout: server did not respond for ${url}`);
					return;
				}
			}
			// bodyBytes is binary-safe; fall back to encoding the text view.
			const outBytes = vRes.bodyBytes ?? textEncoder.encode(vRes.body);
			this.respond(requestId, vRes.statusCode, vRes.headers, outBytes);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : String(error);
			this.respondText(requestId, 500, { 'content-type': 'text/plain' }, `Internal server error: ${messageText}`);
		}
	}

	// ─── WebSocket transport (Phase 2: HMR) ───

	/**
	 * Open a WebSocket into the in-VM ws server on behalf of a browser shim.
	 * Fabricates the HTTP upgrade so Vite's real ws server runs its handshake,
	 * then bridges frames ⟷ the shim's message-level protocol.
	 */
	private handleWsOpen(msg: SwWsOpenMessage): void {
		const { connId, port, url, protocol } = msg;
		const upgradeHandler = getUpgradeHandlers(this.portRegistry).get(port);
		if (!upgradeHandler) {
			this.port?.postMessage({ type: 'ws-close', connId });
			return;
		}

		const conn: WsConnection = {
			socket: null as unknown as SwUpgradeSocket,
			decoder: new FrameDecoder(),
			handshakeDone: false,
			fragments: [],
			fragmentOpcode: 0,
		};

		const socket = new SwUpgradeSocket(
			(bytes) => this.onServerBytes(connId, bytes),
			() => {
				if (this.wsConns.delete(connId)) {
					this.port?.postMessage({ type: 'ws-close', connId });
				}
			},
		);
		conn.socket = socket;
		this.wsConns.set(connId, conn);

		// A fabricated Sec-WebSocket-Key; the shim provides no Origin (the ws
		// server validates Origin against its own host and the browser page
		// carries the preview origin) and no Extensions (skip permessage-deflate
		// so the bridge never has to inflate).
		const keyBytes = new Uint8Array(16);
		randomMask(keyBytes);
		const headers: Record<string, string> = {
			upgrade: 'websocket',
			connection: 'Upgrade',
			'sec-websocket-version': '13',
			'sec-websocket-key': bytesToBase64(keyBytes),
		};
		if (protocol) headers['sec-websocket-protocol'] = protocol;

		const delivered = upgradeHandler({ method: 'GET', url, headers }, socket, new Uint8Array(0));
		if (!delivered) {
			this.wsConns.delete(connId);
			socket.destroy();
		}
	}

	/** Bytes the in-VM ws server wrote toward the browser: 101 handshake, then frames. */
	private onServerBytes(connId: string, bytes: Uint8Array): void {
		const conn = this.wsConns.get(connId);
		if (!conn) return;
		let frameBytes = bytes;

		if (!conn.handshakeDone) {
			const split = splitHandshake(bytes);
			if (!split) return; // handshake response not complete yet
			conn.handshakeDone = true;
			this.port?.postMessage({ type: 'ws-opened', connId });
			if (split.rest.length === 0) return;
			frameBytes = split.rest;
		}

		for (const frame of conn.decoder.push(frameBytes)) {
			this.onServerFrame(connId, conn, frame);
		}
	}

	private onServerFrame(connId: string, conn: WsConnection, frame: { opcode: number; payload: Uint8Array; fin: boolean }): void {
		if (frame.opcode === OPCODE.ping) {
			// Auto-pong on the shim's behalf.
			conn.socket.emit('data', encodeFrame(OPCODE.pong, frame.payload, randomMask));
			return;
		}
		if (frame.opcode === OPCODE.pong) return;
		if (frame.opcode === OPCODE.close) {
			conn.socket.destroy();
			return;
		}

		// text / binary / continuation — reassemble fragments.
		if (frame.opcode !== OPCODE.continuation) conn.fragmentOpcode = frame.opcode;
		conn.fragments.push(frame.payload);
		if (!frame.fin) return;

		let total = 0;
		for (const f of conn.fragments) total += f.length;
		const full = new Uint8Array(total);
		let off = 0;
		for (const f of conn.fragments) { full.set(f, off); off += f.length; }
		conn.fragments = [];

		const binary = conn.fragmentOpcode === OPCODE.binary;
		this.port?.postMessage({
			type: 'ws-message',
			connId,
			data: bytesToBase64(full),
			binary,
		});
	}

	/** A message the browser shim sent → frame it (masked) into the ws server. */
	private handleWsSend(msg: SwWsSendMessage): void {
		const conn = this.wsConns.get(msg.connId);
		if (!conn || conn.socket.destroyed) return;
		const payload = base64ToBytes(msg.data);
		const opcode = msg.binary ? OPCODE.binary : OPCODE.text;
		conn.socket.emit('data', encodeFrame(opcode, payload, randomMask));
	}

	private handleWsClose(msg: SwWsCloseMessage): void {
		const conn = this.wsConns.get(msg.connId);
		if (!conn) return;
		this.wsConns.delete(msg.connId);
		// Send a WS close frame, then tear the socket down.
		if (!conn.socket.destroyed) {
			conn.socket.emit('data', encodeFrame(OPCODE.close, new Uint8Array(0), randomMask));
			conn.socket.destroy();
		}
	}
}
