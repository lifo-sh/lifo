/**
 * vm-websocket.ts — the host-facing half of `sandbox.connect()`.
 *
 * `openWsPipe` handles the RFC 6455 side; this wraps one pipe in something that
 * behaves like a `WebSocket`, so host code (a test, a bench, a CI script) can
 * drive an in-VM ws server the way app code would.
 *
 * Deliberately WebSocket-*shaped* rather than a real `WebSocket`: there is no
 * socket and no URL a browser could open, so pretending harder would only mislead.
 */

import { openWsPipe, type WsPipe } from '../kernel/network/ws-pipe.js';
import type { VirtualRequestHandler } from '../kernel/index.js';

const textDecoder = new TextDecoder();

export interface SandboxConnectOptions {
	/** Sub-protocol to offer the server. */
	protocol?: string;
	/** Milliseconds to wait for the handshake (default 30s). */
	timeout?: number;
}

/** Event shape delivered to handlers. Mirrors the fields that actually matter. */
export interface VmMessageEvent {
	data: string | Uint8Array;
}

export interface VmCloseEvent {
	code: number;
	reason: string;
	wasClean: boolean;
}

export type VmWebSocketEvent = 'open' | 'message' | 'close' | 'error';

export interface VmWebSocket {
	readonly readyState: 0 | 1 | 2 | 3;
	send(data: string | Uint8Array): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: VmMessageEvent) => void) | null;
	onclose: ((event: VmCloseEvent) => void) | null;
	onerror: ((error: Error) => void) | null;
	/**
	 * `message` handlers receive a {@link VmMessageEvent}, `close` handlers a
	 * {@link VmCloseEvent}, `open` nothing, `error` an `Error`. Typed loosely
	 * rather than with overloads so one implementation satisfies every type.
	 */
	addEventListener(type: VmWebSocketEvent, fn: (payload?: never) => void): void;
	removeEventListener(type: VmWebSocketEvent, fn: (payload?: never) => void): void;
	/** Resolves with the next message — convenient in tests. */
	nextMessage(timeoutMs?: number): Promise<string | Uint8Array>;
}

/**
 * Open a WebSocket-shaped connection to the in-VM server on `port`.
 *
 * Resolves only once the server has completed its handshake, so a `send()`
 * straight after `await` is safe. Rejects if nothing on that port handles
 * upgrades, or if the handshake doesn't complete in time.
 */
export function connectVmWebSocket(
	portRegistry: Map<number, VirtualRequestHandler>,
	port: number,
	url: string,
	options: SandboxConnectOptions = {},
): Promise<VmWebSocket> {
	return new Promise<VmWebSocket>((resolve, reject) => {
		const listeners: Record<VmWebSocketEvent, Array<(payload?: never) => void>> = {
			open: [], message: [], close: [], error: [],
		};
		/** Messages that arrived before anyone asked — so nextMessage() can't miss one. */
		const queued: Array<string | Uint8Array> = [];
		const waiters: Array<(data: string | Uint8Array) => void> = [];

		let readyState: 0 | 1 | 2 | 3 = 0;
		let pipe: WsPipe | null = null;
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			pipe?.close();
			reject(new Error(`Timed out after ${options.timeout ?? 30_000}ms opening a WebSocket to port ${port}${url}`));
		}, options.timeout ?? 30_000);

		/**
		 * Message events waiting for a handler.
		 *
		 * A server often writes its first message in the same socket write as the
		 * 101 handshake (Vite's HMR greeting does), so it arrives while `connect()`
		 * is still resolving — before the caller can attach a handler. Microtask
		 * deferral is not enough: `resolve()` takes extra ticks, so a
		 * `queueMicrotask` queued right after it still runs before the caller's
		 * `await` continuation.
		 *
		 * So message events are buffered until a handler exists, and flushed the
		 * moment one is attached. A late handler therefore still sees the greeting
		 * — unusual for an EventTarget, but the alternative here is silently losing
		 * it, and `nextMessage()` (queue-backed) never had this problem.
		 */
		const pendingEvents: VmMessageEvent[] = [];
		const hasMessageHandler = () => api.onmessage != null || listeners.message.length > 0;
		const flushMessages = () => {
			while (pendingEvents.length > 0 && hasMessageHandler()) {
				emit('message', pendingEvents.shift()!);
			}
		};

		let onmessageHandler: ((event: VmMessageEvent) => void) | null = null;

		const api: VmWebSocket = {
			get readyState() { return readyState; },
			send(data) {
				if (readyState !== 1) throw new Error('WebSocket is not open');
				pipe?.send(data);
			},
			close() {
				if (readyState >= 2) return;
				readyState = 2;
				pipe?.close();
			},
			onopen: null,
			get onmessage() { return onmessageHandler; },
			set onmessage(fn: ((event: VmMessageEvent) => void) | null) {
				onmessageHandler = fn;
				if (fn) flushMessages();
			},
			onclose: null,
			onerror: null,
			addEventListener(type: VmWebSocketEvent, fn: (payload?: never) => void) {
				listeners[type]?.push(fn);
				if (type === 'message') flushMessages();
			},
			removeEventListener(type: VmWebSocketEvent, fn: (payload?: never) => void) {
				const arr = listeners[type];
				if (!arr) return;
				const i = arr.indexOf(fn);
				if (i >= 0) arr.splice(i, 1);
			},
			nextMessage(timeoutMs = 10_000) {
				const buffered = queued.shift();
				if (buffered !== undefined) return Promise.resolve(buffered);
				return new Promise((res, rej) => {
					const t = setTimeout(() => {
						const i = waiters.indexOf(deliver);
						if (i >= 0) waiters.splice(i, 1);
						rej(new Error(`Timed out after ${timeoutMs}ms waiting for a WebSocket message`));
					}, timeoutMs);
					const deliver = (data: string | Uint8Array) => { clearTimeout(t); res(data); };
					waiters.push(deliver);
				});
			},
		};

		const emit = (type: VmWebSocketEvent, payload?: unknown) => {
			const handler = type === 'open' ? api.onopen
				: type === 'message' ? api.onmessage
					: type === 'close' ? api.onclose
						: api.onerror;
			if (handler) {
				try { (handler as (p?: unknown) => void)(payload); } catch { /* a handler's own error is not ours */ }
			}
			for (const fn of [...(listeners[type] ?? [])]) {
				try { (fn as unknown as (p?: unknown) => void)(payload); } catch { /* ditto */ }
			}
		};

		pipe = openWsPipe(portRegistry, port, url, {
			onOpen() {
				readyState = 1;
				if (!settled) { settled = true; clearTimeout(timer); resolve(api); }
				emit('open');
			},
			onMessage(payload, binary) {
				const data: string | Uint8Array = binary ? payload : textDecoder.decode(payload);
				const waiter = waiters.shift();
				if (waiter) waiter(data);
				else queued.push(data);
				// Buffered rather than emitted now — see pendingEvents.
				pendingEvents.push({ data } satisfies VmMessageEvent);
				flushMessages();
			},
			onClose() {
				const wasOpen = readyState === 1;
				readyState = 3;
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new Error(`WebSocket to port ${port}${url} closed before the handshake completed`));
					return;
				}
				clearTimeout(timer);
				emit('close', { code: wasOpen ? 1000 : 1006, reason: '', wasClean: wasOpen } satisfies VmCloseEvent);
			},
		}, { protocol: options.protocol });

		if (!pipe) {
			settled = true;
			clearTimeout(timer);
			reject(new Error(`No server handling WebSocket upgrades on port ${port} (is it listening? try sandbox.waitForPort)`));
		}
	});
}
