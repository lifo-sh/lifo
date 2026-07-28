/**
 * ws-pipe.ts — one WebSocket connection into an in-VM ws server.
 *
 * An in-VM server (Vite HMR, Metro, supabase realtime) speaks RFC 6455 over a
 * Node socket. Nothing outside the VM has such a socket, so every transport
 * fabricates one: it forges the HTTP upgrade so the real server runs its own
 * handshake, then translates frames to whatever its consumer speaks — a
 * MessagePort, a postMessage shim, a relay socket, or a plain callback.
 *
 * That translation was written twice (`SwUpgradeSocket` in ServiceWorkerBridge,
 * `VirtualUpgradeSocket` in WebSocketTunnel) with the frame loop duplicated
 * alongside each. Both live here now, expressed once, with the transport reduced
 * to four callbacks.
 *
 * What this owns, and why each piece is not obvious:
 * - **The socket stand-in.** In-VM `ws` pokes Node-internal fields
 *   (`_readableState`, `_writableState`) directly on close, so they have to
 *   exist or the server throws while tearing a connection down.
 * - **The handshake split.** The server writes `101 …\r\n\r\n` and may append
 *   frame bytes in the SAME write, so the boundary has to be found and the
 *   remainder fed to the decoder — dropping it loses the first HMR message.
 * - **Fragment reassembly.** A large payload arrives as continuation frames; the
 *   opcode lives only on the first, so it is remembered.
 * - **Auto-pong.** Nothing above this layer knows about control frames, and a
 *   server that pings and never hears back drops the connection.
 */

import { getUpgradeHandlers } from '../../node-compat/http.js';
import { EventEmitter } from '../../node-compat/events.js';
import { Buffer } from '../../node-compat/buffer.js';
import { encodeFrame, FrameDecoder, OPCODE, splitHandshake } from './ws-frame.js';
import type { VirtualRequestHandler } from '../index.js';

const textEncoder = new TextEncoder();

/** Fills `out` with random bytes; the fallback's values don't affect correctness. */
export function randomMask(out: Uint8Array): void {
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		crypto.getRandomValues(out);
	} else {
		// Deterministic fallback (non-browser hosts / tests) — only the presence of
		// the mask bit matters to a server, not the value.
		for (let i = 0; i < out.length; i++) out[i] = (i * 41 + 7) & 0xff;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

/**
 * Socket stand-in handed to an in-VM ws server in place of a TCP socket.
 *
 * The server reads and writes RFC 6455 bytes here; the pipe frames/deframes them
 * for the transport above.
 */
export class VirtualUpgradeSocket extends EventEmitter {
	readable = true;
	writable = true;
	destroyed = false;
	remoteAddress = '127.0.0.1';
	/** Node-internal-shaped state that `ws` pokes directly on socket close. */
	_readableState = { endEmitted: false, ended: false };
	_writableState = { finished: false, errorEmitted: false, ended: false };

	constructor(
		private sendBytes: (data: Uint8Array) => void,
		private sendClose: () => void,
	) {
		super();
	}

	write(data: string | Uint8Array, encodingOrCb?: unknown, cb?: () => void): boolean {
		const callback = typeof encodingOrCb === 'function' ? (encodingOrCb as () => void) : cb;
		if (!this.destroyed) {
			this.sendBytes(typeof data === 'string' ? textEncoder.encode(data) : data);
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
		this._readableState.ended = true;
		this._writableState.finished = true;
		this.sendClose();
		this.emit('close');
		return this;
	}

	/** Pull-mode read — `ws` drains on close; nothing is buffered here. */
	read(): null { return null; }
	unshift(_chunk?: unknown): void {}
	setTimeout(): this { return this; }
	setNoDelay(): this { return this; }
	setKeepAlive(): this { return this; }
	pause(): this { return this; }
	resume(): this { return this; }
	cork(): void {}
	uncork(): void {}
}

/** What the transport above the pipe is told. */
export interface WsPipeHooks {
	/** The server completed its 101 handshake. */
	onOpen(): void;
	/** A whole (re-assembled) application message arrived from the server. */
	onMessage(payload: Uint8Array, binary: boolean): void;
	/** The connection ended, from either side. */
	onClose(): void;
}

export interface WsPipeOptions {
	/** Sub-protocol to offer, if the client asked for one. */
	protocol?: string;
}

/** A live pipe. `send`/`close` come from the transport; the hooks fire the other way. */
export interface WsPipe {
	send(data: string | Uint8Array, binary?: boolean): void;
	close(): void;
	readonly destroyed: boolean;
}

/**
 * Open a WebSocket into the in-VM server listening on `port`.
 *
 * Returns `null` when no server on that port handles upgrades — the caller
 * should report a close to its client.
 */
export function openWsPipe(
	portRegistry: Map<number, VirtualRequestHandler>,
	port: number,
	url: string,
	hooks: WsPipeHooks,
	options: WsPipeOptions = {},
): WsPipe | null {
	const upgradeHandler = getUpgradeHandlers(portRegistry).get(port);
	if (!upgradeHandler) return null;

	const decoder = new FrameDecoder();
	let handshakeDone = false;
	let fragments: Uint8Array[] = [];
	let fragmentOpcode = 0;
	let closed = false;

	const finish = () => {
		if (closed) return;
		closed = true;
		hooks.onClose();
	};

	const socket = new VirtualUpgradeSocket(
		(bytes) => onServerBytes(bytes),
		() => finish(),
	);

	function onServerFrame(frame: { opcode: number; payload: Uint8Array; fin: boolean }): void {
		if (frame.opcode === OPCODE.ping) {
			// Auto-pong on the client's behalf: a server that pings and hears
			// nothing back will drop the connection.
			socket.emit('data', encodeFrame(OPCODE.pong, frame.payload, randomMask));
			return;
		}
		if (frame.opcode === OPCODE.pong) return;
		if (frame.opcode === OPCODE.close) {
			socket.destroy();
			return;
		}

		// text / binary / continuation — the opcode is only on the first frame.
		if (frame.opcode !== OPCODE.continuation) fragmentOpcode = frame.opcode;
		fragments.push(frame.payload);
		if (!frame.fin) return;

		let total = 0;
		for (const f of fragments) total += f.length;
		const full = new Uint8Array(total);
		let off = 0;
		for (const f of fragments) { full.set(f, off); off += f.length; }
		fragments = [];

		hooks.onMessage(full, fragmentOpcode === OPCODE.binary);
	}

	function onServerBytes(bytes: Uint8Array): void {
		let frameBytes = bytes;

		if (!handshakeDone) {
			const split = splitHandshake(bytes);
			if (!split) return; // 101 response not complete yet
			handshakeDone = true;
			hooks.onOpen();
			// The server may append frame bytes to the same write as the handshake;
			// dropping them loses the first message (e.g. Vite's initial HMR ping).
			if (split.rest.length === 0) return;
			frameBytes = split.rest;
		}

		for (const frame of decoder.push(frameBytes)) onServerFrame(frame);
	}

	// A fabricated Sec-WebSocket-Key. No Origin (a caller's client carries the
	// real one and the server validates against its own host) and no Extensions,
	// so permessage-deflate is never negotiated and this never has to inflate.
	const keyBytes = new Uint8Array(16);
	randomMask(keyBytes);
	const headers: Record<string, string> = {
		upgrade: 'websocket',
		connection: 'Upgrade',
		'sec-websocket-version': '13',
		'sec-websocket-key': bytesToBase64(keyBytes),
	};
	if (options.protocol) headers['sec-websocket-protocol'] = options.protocol;

	const delivered = upgradeHandler({ method: 'GET', url, headers }, socket, new Uint8Array(0));
	if (!delivered) {
		socket.destroy();
		return null;
	}

	return {
		send(data: string | Uint8Array, binary?: boolean): void {
			if (socket.destroyed) return;
			const isBinary = binary ?? typeof data !== 'string';
			const payload = typeof data === 'string' ? textEncoder.encode(data) : data;
			const opcode = isBinary ? OPCODE.binary : OPCODE.text;
			// Emit a Buffer, not a raw Uint8Array: in-VM ws servers index into it
			// with Buffer methods while parsing the frame header.
			socket.emit('data', Buffer.from(encodeFrame(opcode, payload, randomMask)));
		},
		close(): void {
			socket.destroy();
		},
		get destroyed(): boolean {
			return socket.destroyed;
		},
	};
}
