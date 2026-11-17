/**
 * net / tls for a box whose host can open real TCP connections.
 *
 * A browser tab has no TCP, so `require('net')` in a box is a stub there (index.ts). A host that
 * does have it (Lifo Cloud on workerd, with `connect()` from `cloudflare:sockets`) hands the box a
 * connector, `Sandbox.create({ net: { connect } })`, and then `net.connect`, `net.Socket` and
 * `tls.connect` are real: `pg`, `ioredis`, `mysql2` and other clients written against Node sockets
 * reach databases outside the box. Where the box may connect is the host's decision, made in its
 * `connect` (Lifo Cloud refuses loopback and private addresses).
 *
 * Only outbound connections: `net.createServer` stays the in-box stub.
 */

import type { VFS } from '../kernel/vfs/index.js';
import { Buffer } from './buffer.js';
import { Readable } from './stream.js';
import type { ActivityTracker } from './activity.js';

/** One open connection, as the host provides it. */
export interface BoxSocket {
	/** Resolves when the connection is established; rejects when it's refused. */
	opened: Promise<void>;
	/** Bytes from the peer. Set once, before `opened` resolves. */
	onData(cb: (bytes: Uint8Array) => void): void;
	/** The peer closed, or the connection failed (with the error). Called once. */
	onClose(cb: (err?: Error) => void): void;
	write(bytes: Uint8Array): Promise<void>;
	/** Close after pending writes. */
	end(): void;
	/** Close now. */
	destroy(): void;
	/**
	 * Upgrade this plain connection to TLS in place (Postgres and MySQL negotiate SSL this way).
	 * Returns the encrypted connection; this one must not be used afterwards.
	 */
	startTls?(opts: { servername?: string }): BoxSocket;
}

export interface BoxNetConnectOptions {
	host: string;
	port: number;
	/** TLS from the first byte (`tls.connect`). */
	tls?: boolean;
	servername?: string;
}

/** The host's TCP connector, given to a box with `Sandbox.create({ net })`. */
export interface BoxNet {
	connect(opts: BoxNetConnectOptions): BoxSocket;
}

// Keyed by the box's VFS, like the box's login (cloud/box-auth.ts): every `node` run in the box
// finds it without threading it through each command.
const nets = new WeakMap<VFS, BoxNet>();

export function setBoxNet(vfs: VFS, net: BoxNet | undefined): void {
	if (net) nets.set(vfs, net);
	else nets.delete(vfs);
}

export function getBoxNet(vfs: VFS): BoxNet | undefined {
	return nets.get(vfs);
}

type Callback = (err?: Error | null) => void;

interface ConnectTarget {
	host: string;
	port: number;
	servername?: string;
}

/** `connect(port, host, cb)`, `connect({ port, host }, cb)` and `connect(path)` argument forms. */
function parseConnectArgs(args: unknown[]): { target: ConnectTarget | null; cb?: () => void; options: Record<string, unknown> } {
	const cb = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as () => void) : undefined;
	const first = args[0];
	if (first && typeof first === 'object') {
		const o = first as Record<string, unknown>;
		if (o.port === undefined) return { target: null, cb, options: o };
		return {
			target: { host: String(o.host ?? o.hostname ?? 'localhost'), port: Number(o.port), servername: o.servername as string | undefined },
			cb,
			options: o,
		};
	}
	if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
		return { target: { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) }, cb, options: {} };
	}
	return { target: null, cb, options: {} };
}

function toBytes(chunk: unknown, encoding?: string): Uint8Array {
	if (typeof chunk === 'string') return Buffer.from(chunk, (encoding as BufferEncoding) || 'utf8');
	if (chunk instanceof Uint8Array) return chunk;
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	return Buffer.from(String(chunk));
}

function socketError(err: unknown, target: ConnectTarget | null): Error {
	const e = err instanceof Error ? err : new Error(String(err));
	const out = e as Error & { code?: string; address?: string; port?: number; syscall?: string };
	if (!out.code) out.code = /refus|not allowed|denied|private|loopback/i.test(e.message) ? 'ECONNREFUSED' : 'ECONNRESET';
	if (target) {
		out.address = target.host;
		out.port = target.port;
	}
	out.syscall = 'connect';
	return out;
}

/** The `net` and `tls` exports that replace the stubs when the box has a connector. */
export function createNet(net: BoxNet, activity?: ActivityTracker): { Socket: unknown; connect: (...args: unknown[]) => unknown; tlsConnect: (...args: unknown[]) => unknown; TLSSocket: unknown } {
	class Socket extends Readable {
		writable = true;
		connecting = false;
		pending = true;
		encrypted = false;
		authorized = false;
		remoteAddress: string | undefined;
		remotePort: number | undefined;
		remoteFamily = 'IPv4';
		localAddress = '0.0.0.0';
		localPort = 0;
		bytesRead = 0;
		bytesWritten = 0;
		writableLength = 0;
		timeout = 0;
		readyState: 'opening' | 'open' | 'closed' = 'closed';

		/** @internal */ _conn: BoxSocket | null = null;
		/** @internal */ _target: ConnectTarget | null = null;
		private _queue: Array<{ bytes: Uint8Array; cb?: Callback }> = [];
		private _writeChain: Promise<void> = Promise.resolve();
		private _ending = false;
		private _closed = false;
		private _idleTimer: ReturnType<typeof setTimeout> | null = null;
		// As in Node, an open socket keeps the program running until it closes or is unref'd
		// (the runner ends a run when nothing is pending: activity.ts).
		private _held: (() => void) | null = null;
		private _refd = true;

		constructor(_opts?: unknown) {
			super();
			// Sockets deliver data as soon as there's a 'data' listener; nothing to pull.
		}

		connect(...args: unknown[]): this {
			const { target, cb } = parseConnectArgs(args);
			if (cb) this.once('connect', cb);
			if (!target) {
				queueMicrotask(() => this._fail(new Error('Unix sockets and pipes are not available in a Lifo box')));
				return this;
			}
			this._open(target, () => net.connect({ host: target.host, port: target.port }));
			return this;
		}

		/** @internal Starts a connection made by `open` and wires it to this socket. */
		_open(target: ConnectTarget, open: () => BoxSocket, event: 'connect' | 'secureConnect' = 'connect'): void {
			this._target = target;
			this.connecting = true;
			this.readyState = 'opening';
			if (this._refd) this._held = activity?.begin() ?? null;
			this.remoteAddress = target.host;
			this.remotePort = target.port;
			let conn: BoxSocket;
			try {
				conn = open();
			} catch (e) {
				queueMicrotask(() => this._fail(e));
				return;
			}
			this._attach(conn);
			conn.opened.then(
				() => {
					if (this._closed) return;
					this.connecting = false;
					this.pending = false;
					this.readyState = 'open';
					if (event === 'secureConnect') {
						this.encrypted = true;
						this.authorized = true;
						this.emit('connect');
					}
					this.emit(event);
					this.emit('ready');
					this._flush();
				},
				(e) => this._fail(e),
			);
		}

		/** @internal */
		_attach(conn: BoxSocket): void {
			this._conn = conn;
			conn.onData((bytes) => {
				if (this._closed || this._conn !== conn) return;
				this.bytesRead += bytes.length;
				this._touch();
				this.push(Buffer.from(bytes));
			});
			conn.onClose((err) => {
				if (this._conn !== conn) return; // replaced by its TLS upgrade
				if (err) this._fail(err);
				else this._finish();
			});
		}

		/** @internal The plain connection, handed over to a TLS upgrade. */
		_detach(): BoxSocket | null {
			const conn = this._conn;
			this._conn = null;
			this._held?.();
			this._held = null;
			return conn;
		}

		private _flush(): void {
			const conn = this._conn;
			if (!conn || this.connecting) return;
			const queue = this._queue;
			this._queue = [];
			for (const { bytes, cb } of queue) {
				this._writeChain = this._writeChain
					.then(() => conn.write(bytes))
					.then(
						() => {
							this.writableLength -= bytes.length;
							this.bytesWritten += bytes.length;
							cb?.();
							if (this.writableLength === 0) this.emit('drain');
						},
						(e) => {
							cb?.(e as Error);
							this._fail(e);
						},
					);
			}
			if (this._ending) {
				this._writeChain = this._writeChain.then(() => {
					this.emit('finish');
					conn.end();
				});
			}
		}

		write(chunk: unknown, encodingOrCb?: unknown, cb?: Callback): boolean {
			const callback = (typeof encodingOrCb === 'function' ? encodingOrCb : cb) as Callback | undefined;
			if (this._closed || this._ending) {
				const err = Object.assign(new Error('This socket has been ended by the other party'), { code: 'EPIPE' });
				queueMicrotask(() => callback?.(err));
				return false;
			}
			const bytes = toBytes(chunk, typeof encodingOrCb === 'string' ? encodingOrCb : undefined);
			this.writableLength += bytes.length;
			this._queue.push({ bytes, cb: callback });
			this._touch();
			this._flush();
			return this.writableLength < 1024 * 1024;
		}

		end(chunk?: unknown, encodingOrCb?: unknown, cb?: Callback): this {
			const callback = (typeof chunk === 'function' ? chunk : typeof encodingOrCb === 'function' ? encodingOrCb : cb) as Callback | undefined;
			if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') this.write(chunk, typeof encodingOrCb === 'string' ? encodingOrCb : undefined);
			if (callback) this.once('finish', () => callback());
			if (this._ending || this._closed) return this;
			this._ending = true;
			this.writable = false;
			this._flush();
			return this;
		}

		destroy(err?: Error): this {
			if (this._closed) return this;
			if (err) this._fail(err);
			else this._finish();
			return this;
		}

		destroySoon(): void {
			this.end();
		}

		private _fail(err: unknown): void {
			if (this._closed) return;
			const e = socketError(err, this._target);
			this._teardown();
			this.emit('error', e);
			this.emit('close', true);
		}

		private _finish(): void {
			if (this._closed) return;
			this._teardown();
			// Readable's end path emits 'end' then 'close' once buffered data is read.
			this.push(null);
		}

		private _teardown(): void {
			this._closed = true;
			this.connecting = false;
			this.writable = false;
			this.readyState = 'closed';
			if (this._idleTimer) clearTimeout(this._idleTimer);
			this._idleTimer = null;
			this._held?.();
			this._held = null;
			const conn = this._conn;
			this._conn = null;
			try {
				conn?.destroy();
			} catch {
				// already closed
			}
			// Unlike a pushed end, a failure or destroy ends the stream at once.
			queueMicrotask(() => {
				this.destroyed = true;
			});
		}

		private _touch(): void {
			if (!this.timeout) return;
			if (this._idleTimer) clearTimeout(this._idleTimer);
			this._idleTimer = setTimeout(() => this.emit('timeout'), this.timeout);
		}

		setTimeout(ms: number, cb?: () => void): this {
			this.timeout = ms;
			if (cb) this.once('timeout', cb);
			if (this._idleTimer) clearTimeout(this._idleTimer);
			this._idleTimer = null;
			if (ms) this._touch();
			return this;
		}

		setNoDelay(): this { return this; }
		setKeepAlive(): this { return this; }
		setEncoding(): this { return this; }
		ref(): this {
			this._refd = true;
			if (!this._held && !this._closed && this.readyState !== 'closed') this._held = activity?.begin() ?? null;
			return this;
		}
		unref(): this {
			this._refd = false;
			this._held?.();
			this._held = null;
			return this;
		}
		cork(): void {}
		uncork(): void {}
		address(): { address: string; family: string; port: number } {
			return { address: this.localAddress, family: 'IPv4', port: this.localPort };
		}
		getPeerCertificate(): Record<string, unknown> { return {}; }
		getCipher(): Record<string, unknown> { return {}; }
		getProtocol(): string | null { return this.encrypted ? 'TLSv1.3' : null; }
	}

	function connect(...args: unknown[]): unknown {
		const socket = new Socket();
		socket.connect(...args);
		return socket;
	}

	/**
	 * `tls.connect(port, host, opts, cb)`, `tls.connect({ host, port, servername })`, and the
	 * upgrade form `tls.connect({ socket, servername })` that pg and mysql2 use after asking the
	 * server for SSL on a plain connection.
	 */
	function tlsConnect(...args: unknown[]): unknown {
		const { target, cb, options } = parseConnectArgs(args);
		const extra = args.find((a, i) => i > 0 && a && typeof a === 'object') as Record<string, unknown> | undefined;
		const opts = { ...extra, ...options };
		const socket = new Socket();
		if (cb) socket.once('secureConnect', cb);
		const plain = opts.socket as (InstanceType<typeof Socket> & { _detach?: () => BoxSocket | null }) | undefined;
		if (plain && typeof plain._detach === 'function') {
			const servername = (opts.servername as string | undefined) || plain._target?.host;
			const under = plain._detach();
			const upgradeTarget = { host: plain._target?.host ?? '', port: plain._target?.port ?? 0, servername };
			socket._open(
				upgradeTarget,
				() => {
					if (!under?.startTls) throw new Error('This connection cannot be upgraded to TLS');
					return under.startTls({ servername });
				},
				'secureConnect',
			);
			return socket;
		}
		if (!target) {
			queueMicrotask(() => socket.destroy(new Error('tls.connect needs a host and port, or a socket to upgrade')));
			return socket;
		}
		const servername = (opts.servername as string | undefined) || target.host;
		socket._open(target, () => net.connect({ host: target.host, port: target.port, tls: true, servername }), 'secureConnect');
		return socket;
	}

	return { Socket, connect, tlsConnect, TLSSocket: Socket };
}
