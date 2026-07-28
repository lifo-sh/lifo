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
import { getUpgradeHandlers } from '../../node-compat/http.js';
import { EventEmitter } from '../../node-compat/events.js';
import { Buffer } from '../../node-compat/buffer.js';
import { encodeFrame, FrameDecoder, OPCODE, splitHandshake } from './ws-frame.js';
import { dispatchRequest } from './dispatch.js';

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

/**
 * Every live bridge, keyed by its box id. Each example/sandbox in the page
 * owns its OWN kernel + bridge, so the SW must route /_sw/<boxId>/<port>/ to
 * the RIGHT box — a single "last connect wins" host would break every other
 * example's preview the moment a new one connected. When the SW restarts (idle
 * eviction / update) it loses all ports, so every bridge re-announces.
 */
const activeBridges = new Map<string, ServiceWorkerBridge>();
let swListenerInstalled = false;

function makeBoxId(): string {
	const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2);
	// Alphanumeric only: the SW's `box_<id>` prefix must be distinguishable from
	// a bare `/_sw/<port>/` (all-digits) path, so no dashes.
	return 'box_' + rnd.replace(/[^a-z0-9]/gi, '').slice(0, 10);
}

export class ServiceWorkerBridge {
	/** Stable id for this box; the SW routes /_sw/<boxId>/<port>/ here. */
	readonly boxId: string = makeBoxId();
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
			activeBridges.set(this.boxId, this);

			if (!swListenerInstalled) {
				swListenerInstalled = true;
				// SW woke without state / was replaced → every box re-announces.
				const reconnectAll = () => { for (const b of activeBridges.values()) void b.reconnect(); };
				navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
					if ((event.data as { type?: string })?.type === 'lifo-need-host') reconnectAll();
				});
				navigator.serviceWorker.addEventListener('controllerchange', reconnectAll);
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
		controller.postMessage({ type: 'lifo-connect', boxId: this.boxId }, [channel.port2]);
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

	/**
	 * Tear down this bridge: drop its WS connections, detach the port, and
	 * remove it from the active-bridges registry so the SW stops routing to it
	 * and it no longer reconnects on controllerchange. Used when a box reboots.
	 */
	destroy(): void {
		for (const conn of this.wsConns.values()) conn.socket.destroy();
		this.wsConns.clear();
		this.detach();
		activeBridges.delete(this.boxId);
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

		// The shared dispatcher owns the `_donePromise` await, the 120s bound, the
		// bodyBytes fallback, and the 404/504/500 shapes — all of which were
		// written here first and are now used by every transport. `x-lifo:
		// no-server` on an unbound port lets the SW render a friendly
		// auto-reloading page for document requests while curl keeps the terse
		// text.
		const res = await dispatchRequest(this.portRegistry, port, {
			method,
			url,
			headers,
			body: body ? base64ToBytes(body) : undefined,
		});
		this.respond(requestId, res.statusCode, res.headers, res.bodyBytes);
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
		// Emit a Buffer (not a raw Uint8Array): in-VM ws servers (e.g. Metro's HMR
		// server via the `ws` package) parse frames with Buffer methods like
		// readUInt16BE, which a plain Uint8Array lacks.
		conn.socket.emit('data', Buffer.from(encodeFrame(opcode, payload, randomMask)));
	}

	private handleWsClose(msg: SwWsCloseMessage): void {
		const conn = this.wsConns.get(msg.connId);
		if (!conn) return;
		this.wsConns.delete(msg.connId);
		// Send a WS close frame, then tear the socket down.
		if (!conn.socket.destroyed) {
			conn.socket.emit('data', Buffer.from(encodeFrame(OPCODE.close, new Uint8Array(0), randomMask)));
			conn.socket.destroy();
		}
	}
}
