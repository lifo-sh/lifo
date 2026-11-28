/**
 * The main-thread half of the WASI threads' filesystem (the thread half is `createFs` in
 * ./thread.ts). A thread posts `{ __lifo_fs__: { sab, method, args } }` and blocks; this
 * runs the call on the box's fs module and writes the answer into `sab`.
 *
 * Values cross as JSON with tagged objects for what JSON can't carry: BigInt (WASI asks for
 * `{ bigint: true }` stats), bytes, stats and dirents (whose isFile()/isDirectory() methods
 * JSON would drop) and errors (keeping code/errno/syscall/path, which WASI maps to errno).
 */

const HEADER_BYTES = 16;

type FsModule = Record<string, unknown>;

interface FsRequest {
	sab: SharedArrayBuffer;
	method?: string;
	args?: unknown[];
	/** Token of an earlier answer that didn't fit in the thread's buffer. */
	fetch?: number;
}

function kindOf(v: { isFile?: () => boolean; isDirectory?: () => boolean; isSymbolicLink?: () => boolean }): string {
	if (v.isSymbolicLink?.()) return 'symlink';
	if (v.isDirectory?.()) return 'directory';
	if (v.isFile?.()) return 'file';
	return 'other';
}

function isStatLike(v: Record<string, unknown>): boolean {
	return typeof v.isFile === 'function' && typeof v.isDirectory === 'function' && 'mode' in v && 'size' in v;
}

function isDirentLike(v: Record<string, unknown>): boolean {
	return typeof v.isFile === 'function' && typeof v.isDirectory === 'function' && typeof v.name === 'string' && !('mode' in v);
}

function replacer(_key: string, v: unknown): unknown {
	if (typeof v === 'bigint') return { __lifo: 'bigint', v: v.toString() };
	if (v instanceof Uint8Array) return { __lifo: 'bytes', v: Array.from(v) };
	if (v instanceof Error) {
		const e = v as Error & { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown };
		return { __lifo: 'error', message: e.message, code: e.code, errno: e.errno, syscall: e.syscall, path: e.path };
	}
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		// Buffer#toJSON runs before the replacer.
		if (o.type === 'Buffer' && Array.isArray(o.data)) return { __lifo: 'bytes', v: o.data };
		if (isStatLike(o)) {
			const out: Record<string, unknown> = { __lifo: 'stat', kind: kindOf(o) };
			for (const [k, val] of Object.entries(o)) {
				if (typeof val === 'function' || val instanceof Date) continue;
				out[k] = val;
			}
			return out;
		}
		if (isDirentLike(o)) return { __lifo: 'dirent', kind: kindOf(o), name: o.name, path: o.path ?? o.parentPath };
	}
	return v;
}

const encoder = new TextEncoder();

function encode(value: unknown): Uint8Array {
	if (value === undefined) return new Uint8Array(0);
	return encoder.encode(JSON.stringify(value, replacer));
}

/** Copy views on shared memory, except readSync's output buffer, which must stay shared. */
function unshareArgs(method: string, args: unknown[]): unknown[] {
	return args.map((a, i) => {
		if (method === 'readSync' && i === 1) return a;
		if (a instanceof Uint8Array && typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer) {
			return new Uint8Array(a);
		}
		return a;
	});
}

export interface FsServer {
	/** Answer one request from a thread. Returns false if `data` isn't an fs request. */
	handle(data: unknown): boolean;
}

export function createFsServer(getFs: () => FsModule): FsServer {
	const parked = new Map<number, { status: number; bytes: Uint8Array }>();
	let nextToken = 1;

	function respond(sab: SharedArrayBuffer, status: number, bytes: Uint8Array): void {
		const words = new Int32Array(sab);
		const room = sab.byteLength - HEADER_BYTES;
		if (bytes.length > room) {
			const token = nextToken++;
			parked.set(token, { status, bytes });
			Atomics.store(words, 1, bytes.length);
			Atomics.store(words, 2, token);
			Atomics.store(words, 0, 3);
		} else {
			new Uint8Array(sab, HEADER_BYTES, bytes.length).set(bytes);
			Atomics.store(words, 1, bytes.length);
			Atomics.store(words, 0, status);
		}
		Atomics.notify(words, 0);
	}

	return {
		handle(data: unknown): boolean {
			const req = (data as { __lifo_fs__?: FsRequest } | null)?.__lifo_fs__;
			if (!req) return false;
			if (req.fetch !== undefined) {
				const answer = parked.get(req.fetch) ?? { status: 2, bytes: encode(new Error('fs answer was lost')) };
				parked.delete(req.fetch);
				respond(req.sab, answer.status, answer.bytes);
				return true;
			}
			const method = req.method ?? '';
			let status = 1;
			let bytes: Uint8Array;
			try {
				const fs = getFs();
				const fn = fs[method];
				if (typeof fn !== 'function') {
					const err = new Error(`fs.${method} is not supported in a WASI thread`) as Error & { code: string };
					err.code = 'ENOSYS';
					throw err;
				}
				bytes = encode((fn as (...a: unknown[]) => unknown).apply(fs, unshareArgs(method, req.args ?? [])));
			} catch (e) {
				status = 2;
				const err = e instanceof Error ? e : new Error(String(e));
				bytes = encode(err);
			}
			respond(req.sab, status, bytes);
			return true;
		},
	};
}
