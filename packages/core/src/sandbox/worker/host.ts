/**
 * The box side of WorkerSandbox: runs a real Sandbox inside a Web Worker (or any realm with a
 * MessagePort) and serves it to the page. Call it from your worker entry:
 *
 *   // box.worker.ts
 *   import { serveSandbox } from '@lifo-sh/core';
 *   serveSandbox(self, { setup(box, extra) { box.commands.register('python3', ...) } });
 *
 * Code in the box then runs in the worker's realm, not the page's: it has no DOM, no page globals,
 * no localStorage, sessionStorage or document.cookie. Requests the box makes are sent without the
 * site's cookies (fetch, XMLHttpRequest and EventSource are made credential-less, and WebSockets
 * to the page's own origin are refused). The page lends capabilities only through methods it
 * serves on purpose, such as `auth.getToken`.
 *
 * What a same-origin worker can't hide: it shares the page's origin, so a module import from the
 * site's own URLs still carries cookies, and IndexedDB and the Cache API are shared. A box worker
 * loaded from a separate origin (a cross-origin iframe hosting the worker) closes that gap; this
 * host works unchanged there, only the page's way of getting the port differs.
 */

import { Sandbox } from '../Sandbox.js';
import type { ITerminal } from '../../terminal/ITerminal.js';
import type { SnapshotOptions } from '../types.js';
import { Buffer } from '../../node-compat/buffer.js';
import { ServiceWorkerBridge } from '../../kernel/network/ServiceWorkerBridge.js';
import { RpcChannel, transfer, ownBuffer, type Endpoint } from './rpc.js';

export interface ServeSandboxOptions {
	/**
	 * Called once the box exists, before the page gets it: register commands and packages here
	 * (they must be importable in the worker). `extra` is whatever the page passed as `setup`.
	 */
	setup?(box: Sandbox, extra: unknown): void | Promise<void>;
	/** Make the box's requests credential-less (default true). */
	lockDownCredentials?: boolean;
	/**
	 * Send console output from code in the box (scripts under /home) to the box's terminal, for
	 * long-running processes that log after their top-level code returns (default true).
	 */
	routeConsole?: boolean;
}

export interface CreateRequest {
	env?: Record<string, string>;
	cwd?: string;
	files?: Array<[string, string | ArrayBuffer]>;
	persist?: boolean;
	/** The page serves `auth.getToken`; the box gets only the site it belongs to. */
	auth?: { baseUrl: string } | null;
	/** The page's terminal size, if it shows a terminal. */
	terminal?: { cols: number; rows: number } | null;
	setup?: unknown;
}

/** An ITerminal whose screen is in the page: output is batched into messages, input comes back. */
class RemoteTerminal implements ITerminal {
	cols = 80;
	rows = 24;
	private out = '';
	private scheduled = false;
	private readonly listeners: Array<(data: string) => void> = [];

	constructor(private readonly rpc: RpcChannel) {
		rpc.on('term.in', (data: string) => {
			for (const fn of this.listeners) fn(data);
		});
		rpc.on('term.resize', ({ cols, rows }: { cols: number; rows: number }) => {
			this.cols = cols;
			this.rows = rows;
		});
	}

	write(data: string): void {
		this.out += data;
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			const chunk = this.out;
			this.out = '';
			if (chunk) this.rpc.emit('term.out', chunk);
		});
	}
	writeln(data: string): void {
		this.write(`${data}\r\n`);
	}
	onData(callback: (data: string) => void): void {
		this.listeners.push(callback);
	}
	focus(): void {
		this.rpc.emit('term.focus');
	}
	clear(): void {
		this.rpc.emit('term.clear');
	}
}

let lockedDown = false;

/**
 * Strip the site's credentials from everything code in this realm can send. The original fetch
 * stays in this closure only; code in the box sees the wrapped one.
 */
export function lockDownCredentials(scope: typeof globalThis = globalThis): void {
	if (lockedDown) return;
	lockedDown = true;
	const g = scope as typeof globalThis & Record<string, unknown>;
	const origin = typeof location !== 'undefined' ? location.origin : '';
	const realFetch = g.fetch?.bind(g);
	if (realFetch) {
		const safeFetch = (input: RequestInfo | URL, init?: RequestInit) => realFetch(input, { ...init, credentials: 'omit' });
		Object.defineProperty(g, 'fetch', { value: safeFetch, writable: false, configurable: false });
	}
	const XHR = g.XMLHttpRequest as (typeof XMLHttpRequest) | undefined;
	if (XHR) {
		Object.defineProperty(XHR.prototype, 'withCredentials', { get: () => false, set: () => {}, configurable: false });
	}
	const ES = g.EventSource as (typeof EventSource) | undefined;
	if (ES) {
		class SafeEventSource extends ES {
			constructor(url: string | URL, init?: EventSourceInit) {
				super(url, { ...init, withCredentials: false });
			}
		}
		Object.defineProperty(g, 'EventSource', { value: SafeEventSource, writable: false, configurable: false });
	}
	const WS = g.WebSocket as (typeof WebSocket) | undefined;
	if (WS && origin) {
		const wsOrigin = origin.replace(/^http/, 'ws');
		class SafeWebSocket extends WS {
			constructor(url: string | URL, protocols?: string | string[]) {
				const u = new URL(String(url), origin);
				if (u.origin === wsOrigin || u.origin === origin) {
					throw new DOMException('A box can\'t open a WebSocket to the page\'s own site', 'SecurityError');
				}
				super(u, protocols);
			}
		}
		Object.defineProperty(g, 'WebSocket', { value: SafeWebSocket, writable: false, configurable: false });
	}
}

/**
 * Console output from in-box code that runs after its script's top level (a dev server logging
 * later) would otherwise go to the worker's devtools console; send it to the box's terminal.
 */
function routeConsoleTo(term: () => ITerminal | null): void {
	const real = globalThis.console;
	const fmt = (args: unknown[]) =>
		args
			.map((a) => {
				if (typeof a === 'string') return a;
				if (a instanceof Error) return a.stack ?? a.message;
				try {
					return JSON.stringify(a);
				} catch {
					return String(a);
				}
			})
			.join(' ');
	const routed = Object.create(real) as Console;
	for (const [name, toErr] of [['log', false], ['info', false], ['debug', false], ['warn', true], ['error', true]] as const) {
		const orig = real[name].bind(real);
		routed[name] = (...args: unknown[]) => {
			const t = term();
			if (t && /\/home\//.test(new Error().stack ?? '')) {
				const text = fmt(args).replace(/\r?\n/g, '\r\n');
				t.write((toErr ? `\x1b[31m${text}\x1b[0m` : text) + '\r\n');
				return;
			}
			orig(...args);
		};
	}
	globalThis.console = routed;
}

/**
 * Serve a box over `endpoint` (in a worker: `self`). Returns the channel, mostly for tests.
 */
export function serveSandbox(endpoint: Endpoint, options: ServeSandboxOptions = {}): RpcChannel {
	const rpc = new RpcChannel(endpoint);
	let box: Sandbox | null = null;
	let terminal: RemoteTerminal | null = null;
	let bridge: ServiceWorkerBridge | null = null;
	const runs = new Map<number, AbortController>();

	if (options.lockDownCredentials !== false) lockDownCredentials();
	// Core sets globalThis.Buffer only while a script's top level runs; tools that call Buffer later
	// from async code (Vite's config loader) need it for good. In a worker it's the box's realm.
	(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
	if (options.routeConsole !== false) routeConsoleTo(() => terminal);

	const need = () => {
		if (!box) throw new Error('The box is not booted yet');
		return box;
	};

	rpc.handle('create', async (req: CreateRequest) => {
		if (box) throw new Error('This worker already runs a box');
		const files: Record<string, string | Uint8Array> = {};
		for (const [path, content] of req.files ?? []) files[path] = typeof content === 'string' ? content : new Uint8Array(content);
		if (req.terminal) {
			terminal = new RemoteTerminal(rpc);
			terminal.cols = req.terminal.cols;
			terminal.rows = req.terminal.rows;
		}
		box = await Sandbox.create({
			env: req.env,
			cwd: req.cwd,
			files,
			persist: req.persist,
			terminal: terminal ?? undefined,
			auth: req.auth ? { baseUrl: req.auth.baseUrl, getToken: () => rpc.call<string | null>('auth.getToken') } : undefined,
		});
		await options.setup?.(box, req.setup);
		return { env: { ...box.env }, cwd: box.cwd };
	});

	rpc.handle('run', async (id: number, cmd: string, opts: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string; stream?: boolean } = {}) => {
		const b = need();
		const ac = new AbortController();
		runs.set(id, ac);
		try {
			const r = await b.commands.run(cmd, {
				cwd: opts.cwd,
				env: opts.env,
				timeout: opts.timeout,
				stdin: opts.stdin,
				signal: ac.signal,
				onStdout: opts.stream ? (d) => rpc.emit('run.out', { id, s: 'o', d }) : undefined,
				onStderr: opts.stream ? (d) => rpc.emit('run.out', { id, s: 'e', d }) : undefined,
			});
			return { ...r, cwd: b.cwd };
		} finally {
			runs.delete(id);
		}
	});
	rpc.on('run.abort', (id: number) => runs.get(id)?.abort());

	rpc.handle('fs', async (op: string, args: unknown[]) => {
		const fs = need().fs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
		if (op === 'writeFile' && args[1] instanceof ArrayBuffer) args = [args[0], new Uint8Array(args[1])];
		if (op === 'writeFiles') {
			args = [(args[0] as Array<{ path: string; content: string | ArrayBuffer }>).map((f) => ({ path: f.path, content: typeof f.content === 'string' ? f.content : new Uint8Array(f.content) }))];
		}
		if (typeof fs[op] !== 'function' || op === 'exportSnapshot' || op === 'importSnapshot') throw new Error(`fs.${op} is not available`);
		const out = await fs[op](...args);
		if (out instanceof Uint8Array) {
			const buf = ownBuffer(out);
			return transfer(buf, [buf]);
		}
		return out;
	});

	rpc.handle('exportSnapshot', async (opts?: SnapshotOptions) => {
		const bytes = await need().exportSnapshot(opts);
		const buf = ownBuffer(bytes);
		return transfer(buf, [buf]);
	});
	rpc.handle('importSnapshot', (buf: ArrayBuffer) => need().importSnapshot(new Uint8Array(buf)));
	rpc.handle('waitForPort', (port: number, opts?: { timeout?: number }) => need().waitForPort(port, opts));
	rpc.handle('ports', () => [...need().kernel.portRegistry.keys()]);
	rpc.handle('processes', () =>
		need()
			.shell.getProcessRegistry()
			.getRunning()
			.map((p) => ({ pid: p.pid, command: p.command, args: [...p.args] })),
	);
	// Whether the interactive shell is in the middle of a command (Ctrl+C would stop it).
	rpc.handle('busy', () => !!(need().shell as unknown as { running?: boolean }).running);

	rpc.handle('fetch', async (input: string, init: { method?: string; headers?: Array<[string, string]>; body?: string | ArrayBuffer; port?: number; timeout?: number } = {}) => {
		const res = await need().fetch(input, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			port: init.port,
			timeout: init.timeout,
		});
		const body = await res.arrayBuffer();
		const headers: Array<[string, string]> = [];
		res.headers.forEach((v, k) => headers.push([k, v]));
		return transfer({ status: res.status, statusText: res.statusText, headers, body }, [body]);
	});

	rpc.handle('cwd', (path?: string) => {
		const b = need();
		if (typeof path === 'string') b.cwd = path;
		return b.cwd;
	});
	rpc.handle('env', (key?: string, value?: string | null) => {
		const b = need();
		if (typeof key === 'string') {
			if (value === null) delete b.env[key];
			else if (typeof value === 'string') b.env[key] = value;
		}
		return { ...b.env };
	});

	rpc.handle('attach', async (size: { cols: number; rows: number }) => {
		const b = need();
		if (!terminal) terminal = new RemoteTerminal(rpc);
		terminal.cols = size.cols;
		terminal.rows = size.rows;
		await b.attach(terminal);
		return b.kernel.vfs.readFileString('/etc/motd');
	});
	rpc.handle('detach', () => {
		need().detach();
	});

	// Previews: the page registers the preview service worker and hands this box one end of a
	// channel to it, so requests from preview frames are answered here, never by the page.
	rpc.handle('previews', (port: MessagePort) => {
		const b = need();
		bridge ??= new ServiceWorkerBridge(b.kernel.portRegistry);
		bridge.attach(port);
		return bridge.boxId;
	});

	rpc.handle('destroy', () => {
		if (!box) return;
		const registry = box.shell.getProcessRegistry();
		for (const p of registry.getRunning()) registry.kill(p.pid);
		bridge?.destroy();
		try {
			box.destroy();
		} catch {
			// already gone
		}
		box = null;
	});

	rpc.emit('ready');
	return rpc;
}
