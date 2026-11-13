/**
 * A small request/response + event protocol over a MessagePort-like endpoint (a Worker, a
 * MessagePort, a worker's `self`, or Node's worker_threads port). Used between a page and the box
 * it runs in a Web Worker (WorkerSandbox ⇄ serveSandbox), in both directions: the page calls the
 * box (`run`, `fs.readFile`, ...), and the box calls back into the page only through the few
 * methods the page chose to serve (e.g. `auth.getToken`).
 *
 * Messages are plain structured-clone data. Large buffers (snapshots, file contents) are moved, not
 * copied, by passing them as transferables.
 */

export interface Endpoint {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	start?(): void;
}

type Wire =
	| { lifo: 1; t: 'req'; id: number; m: string; a: unknown[] }
	| { lifo: 1; t: 'res'; id: number; ok: true; v: unknown }
	| { lifo: 1; t: 'res'; id: number; ok: false; e: { name: string; message: string; stack?: string } }
	| { lifo: 1; t: 'evt'; n: string; p: unknown };

type Handler = (...args: any[]) => unknown;

/** A value returned by a handler together with buffers to transfer instead of copy. */
export class Transfer<T> {
	constructor(
		readonly value: T,
		readonly transfer: Transferable[],
	) {}
}

/** Wrap a value so its buffers are transferred to the other side (the sender loses them). */
export function transfer<T>(value: T, buffers: Transferable[]): Transfer<T> {
	return new Transfer(value, buffers);
}

export class RpcChannel {
	private nextId = 1;
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	private handlers = new Map<string, Handler>();
	private listeners = new Map<string, Set<(payload: any) => void>>();
	private closed = false;
	private readonly onMessage = (event: { data: unknown }) => this.receive(event.data);

	constructor(private readonly endpoint: Endpoint) {
		endpoint.addEventListener('message', this.onMessage);
		endpoint.start?.();
	}

	/** Serve `method` for the other side. */
	handle(method: string, fn: Handler): this {
		this.handlers.set(method, fn);
		return this;
	}

	/** Call `method` on the other side. Pass `transferList` to move buffers in `args`. */
	call<T = unknown>(method: string, args: unknown[] = [], transferList: Transferable[] = []): Promise<T> {
		if (this.closed) return Promise.reject(new Error('The box has been shut down'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.endpoint.postMessage({ lifo: 1, t: 'req', id, m: method, a: args } satisfies Wire, transferList);
		});
	}

	/** Fire-and-forget event to the other side. */
	emit(name: string, payload?: unknown, transferList: Transferable[] = []): void {
		if (this.closed) return;
		this.endpoint.postMessage({ lifo: 1, t: 'evt', n: name, p: payload } satisfies Wire, transferList);
	}

	/** Listen for an event from the other side. Returns an unsubscribe function. */
	on(name: string, fn: (payload: any) => void): () => void {
		let set = this.listeners.get(name);
		if (!set) this.listeners.set(name, (set = new Set()));
		set.add(fn);
		return () => set!.delete(fn);
	}

	/** Stop listening and fail every call still waiting. */
	close(reason = 'The box has been shut down'): void {
		if (this.closed) return;
		this.closed = true;
		this.endpoint.removeEventListener('message', this.onMessage);
		for (const p of this.pending.values()) p.reject(new Error(reason));
		this.pending.clear();
	}

	private async receive(data: unknown): Promise<void> {
		const msg = data as Wire;
		if (!msg || typeof msg !== 'object' || msg.lifo !== 1) return;
		if (msg.t === 'evt') {
			for (const fn of this.listeners.get(msg.n) ?? []) fn(msg.p);
			return;
		}
		if (msg.t === 'res') {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.v);
			else p.reject(Object.assign(new Error(msg.e.message), { name: msg.e.name, stack: msg.e.stack }));
			return;
		}
		// A request.
		const fn = this.handlers.get(msg.m);
		try {
			if (!fn) throw new Error(`No such method: ${msg.m}`);
			const out = await fn(...msg.a);
			if (this.closed) return;
			if (out instanceof Transfer) {
				this.endpoint.postMessage({ lifo: 1, t: 'res', id: msg.id, ok: true, v: out.value } satisfies Wire, out.transfer);
			} else {
				this.endpoint.postMessage({ lifo: 1, t: 'res', id: msg.id, ok: true, v: out } satisfies Wire);
			}
		} catch (err) {
			if (this.closed) return;
			const e = err instanceof Error ? err : new Error(String(err));
			this.endpoint.postMessage({ lifo: 1, t: 'res', id: msg.id, ok: false, e: { name: e.name, message: e.message, stack: e.stack } } satisfies Wire);
		}
	}
}

/** The underlying ArrayBuffer of a typed array, sliced if it's a view on a bigger buffer. */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
	return bytes.slice().buffer as ArrayBuffer;
}
