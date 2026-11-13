/**
 * A Lifo box that runs in a Web Worker instead of the page (the page side; the worker runs
 * serveSandbox, see host.ts). Same shape as Sandbox where it can be: commands.run, fs, attach,
 * fetch, waitForPort, snapshots, cwd, env, destroy. What differs:
 *
 * - The box can't reach the page: no DOM, page globals, localStorage, sessionStorage or
 *   document.cookie, and its requests carry no cookies. That's the point.
 * - Commands are registered in the worker (its entry's `setup`), because a function can't cross
 *   from the page into the worker. `commands.register` here throws and says so.
 * - `kernel` and `shell` live in the worker, so there's no direct handle to them.
 * - `destroy()` terminates the worker: every process in the box stops at once.
 *
 *   const box = await WorkerSandbox.create({
 *     worker: new Worker(new URL('./box.worker.ts', import.meta.url), { type: 'module' }),
 *     terminal: document.getElementById('term')!,
 *   });
 *   await box.commands.run('node -e "console.log(typeof document)"'); // undefined
 */

import type { ITerminal } from '../../terminal/ITerminal.js';
import type { BoxAuth } from '../../cloud/box-auth.js';
import type { SnapshotMetadata } from '../../kernel/vfs/snapshot.js';
import type { CommandResult, RunOptions, SnapshotOptions, SandboxFs } from '../types.js';
import type { SandboxFetchInit } from '../Sandbox.js';
import { RpcChannel, ownBuffer, type Endpoint } from './rpc.js';
import type { CreateRequest } from './host.js';
import { openBoxFrame, type BoxFrame, type BoxFrameOptions } from './frame.js';

export interface WorkerSandboxOptions {
	/** The worker running serveSandbox (a module worker), or a function that makes one. */
	worker?: Worker | Endpoint | (() => Worker | Endpoint);
	/**
	 * Run the box on another origin instead (see frame.ts): a host page there starts the worker,
	 * so the box can't reach this site's cookies, storage or IndexedDB at all. Takes precedence
	 * over `worker`.
	 */
	host?: BoxFrameOptions;
	env?: Record<string, string>;
	cwd?: string;
	files?: Record<string, string | Uint8Array>;
	persist?: boolean;
	/** A terminal in the page: an ITerminal, or an element / selector for an xterm.js terminal. */
	terminal?: ITerminal | HTMLElement | string;
	/** The site's login for `lifo` commands in the box; getToken() runs in the page, on request. */
	auth?: BoxAuth;
	/** Passed (structured-cloned) to the worker entry's `setup(box, extra)`. */
	setup?: unknown;
	/** Font size for a terminal created from an element. */
	fontSize?: number;
}

type Waitable = { terminate?: () => void };

function isTerminal(t: unknown): t is ITerminal {
	return !!t && typeof t === 'object' && typeof (t as ITerminal).write === 'function' && typeof (t as ITerminal).onData === 'function';
}

function resolveElement(target: HTMLElement | string): HTMLElement {
	if (typeof target !== 'string') return target;
	const el = document.querySelector<HTMLElement>(target);
	if (!el) throw new Error(`No element matches ${target}`);
	return el;
}

/** Wire a page-side terminal to the box: output in, keystrokes out. Returns an unwire function. */
function wireTerminal(rpc: RpcChannel, term: ITerminal): () => void {
	let live = true;
	const offOut = rpc.on('term.out', (d: string) => live && term.write(d));
	const offClear = rpc.on('term.clear', () => live && term.clear());
	const offFocus = rpc.on('term.focus', () => live && term.focus());
	term.onData((d) => {
		if (live) rpc.emit('term.in', d);
	});
	const resizable = term as ITerminal & { onResize?: (cb: (size: { cols: number; rows: number }) => void) => unknown };
	if (typeof resizable.onResize === 'function') {
		resizable.onResize(({ cols, rows }) => live && rpc.emit('term.resize', { cols, rows }));
	}
	return () => {
		live = false;
		offOut();
		offClear();
		offFocus();
	};
}

export class WorkerSandbox {
	/** Where the box runs. */
	readonly isolation = 'worker' as const;
	readonly commands: {
		run(cmd: string, options?: RunOptions): Promise<CommandResult>;
		register(name: string, handler: unknown): never;
	};
	readonly fs: SandboxFs;
	/** The box's environment as of the last call (read it again with `getEnv()`). */
	env: Record<string, string>;

	private _cwd: string;
	private nextRun = 1;
	private streams = new Map<number, { onStdout?: (d: string) => void; onStderr?: (d: string) => void }>();
	private unwire: (() => void) | null = null;
	private ownTerminal: { dispose?: () => void } | null = null;
	private destroyed = false;
	private frame: BoxFrame | null = null;
	private reannounce: (() => void) | null = null;

	private constructor(
		private readonly rpc: RpcChannel,
		private readonly endpoint: Endpoint & Waitable,
		init: { env: Record<string, string>; cwd: string },
	) {
		this.env = init.env;
		this._cwd = init.cwd;
		rpc.on('run.out', ({ id, s, d }: { id: number; s: 'o' | 'e'; d: string }) => {
			const cb = this.streams.get(id);
			(s === 'o' ? cb?.onStdout : cb?.onStderr)?.(d);
		});
		this.commands = {
			run: (cmd, options) => this.run(cmd, options),
			register: () => {
				throw new Error('A box in a worker registers its commands in the worker: pass them to serveSandbox({ setup }) in the worker entry.');
			},
		};
		const call = <T>(op: string, args: unknown[], transferList: Transferable[] = []) => this.rpc.call<T>('fs', [op, args], transferList);
		this.fs = {
			readFile: ((path: string, encoding?: null) =>
				encoding === null ? call<ArrayBuffer>('readFile', [path, null]).then((b) => new Uint8Array(b)) : call<string>('readFile', [path])) as SandboxFs['readFile'],
			writeFile: (path, content) => {
				if (typeof content === 'string') return call('writeFile', [path, content]);
				const buf = ownBuffer(content).slice(0);
				return call('writeFile', [path, buf], [buf]);
			},
			readdir: (path) => call('readdir', [path]),
			stat: (path) => call('stat', [path]),
			mkdir: (path, options) => call('mkdir', [path, options]),
			rm: (path, options) => call('rm', [path, options]),
			exists: (path) => call('exists', [path]),
			rename: (a, b) => call('rename', [a, b]),
			cp: (a, b) => call('cp', [a, b]),
			writeFiles: (files) => {
				const transferList: Transferable[] = [];
				const wire = files.map((f) => {
					if (typeof f.content === 'string') return { path: f.path, content: f.content };
					const buf = ownBuffer(f.content).slice(0);
					transferList.push(buf);
					return { path: f.path, content: buf };
				});
				return call('writeFiles', [wire], transferList);
			},
			exportSnapshot: (options) => this.exportSnapshot(options),
			importSnapshot: (data) => this.importSnapshot(data),
		};
	}

	static async create(options: WorkerSandboxOptions): Promise<WorkerSandbox> {
		let frame: BoxFrame | null = null;
		let endpoint: Endpoint & Waitable;
		if (options.host) {
			frame = await openBoxFrame(options.host);
			const f = frame;
			endpoint = Object.assign(f.port as unknown as Endpoint, { terminate: () => f.close() });
		} else if (options.worker) {
			endpoint = (typeof options.worker === 'function' ? options.worker() : options.worker) as Endpoint & Waitable;
		} else {
			throw new Error('WorkerSandbox.create needs a `worker` or a `host`');
		}
		const rpc = new RpcChannel(endpoint);
		if (options.auth) {
			const auth = options.auth;
			rpc.handle('auth.getToken', () => auth.getToken());
		}

		// A terminal made here from an element, or one the caller passed in.
		let term: ITerminal | null = null;
		let own: { dispose?: () => void } | null = null;
		if (typeof options.terminal === 'string' || (typeof HTMLElement !== 'undefined' && options.terminal instanceof HTMLElement)) {
			const { Terminal } = await import('@lifo-sh/ui');
			const t = new Terminal(resolveElement(options.terminal), { fontSize: options.fontSize });
			term = t;
			own = t as { dispose?: () => void };
		} else if (isTerminal(options.terminal)) {
			term = options.terminal;
		}
		const unwire = term ? wireTerminal(rpc, term) : null;

		const files: Array<[string, string | ArrayBuffer]> = [];
		const transferList: Transferable[] = [];
		for (const [path, content] of Object.entries(options.files ?? {})) {
			if (typeof content === 'string') files.push([path, content]);
			else {
				const buf = ownBuffer(content).slice(0);
				transferList.push(buf);
				files.push([path, buf]);
			}
		}
		const req: CreateRequest = {
			env: options.env,
			cwd: options.cwd,
			files,
			persist: options.persist,
			auth: options.auth ? { baseUrl: options.auth.baseUrl } : null,
			terminal: term ? { cols: term.cols, rows: term.rows } : null,
			setup: options.setup,
		};
		let init: { env: Record<string, string>; cwd: string };
		try {
			init = await rpc.call('create', [req], transferList);
		} catch (err) {
			rpc.close();
			endpoint.terminate?.();
			throw err;
		}
		const box = new WorkerSandbox(rpc, endpoint, init);
		box.frame = frame;
		box.unwire = unwire;
		box.ownTerminal = own;
		return box;
	}

	/** The working directory as of the last command (set it with `box.cwd = path`). */
	get cwd(): string {
		return this._cwd;
	}
	set cwd(path: string) {
		this._cwd = path;
		void this.rpc.call('cwd', [path]).catch(() => {});
	}

	/** The box's current environment. */
	async getEnv(): Promise<Record<string, string>> {
		this.env = await this.rpc.call<Record<string, string>>('env');
		return this.env;
	}
	/** Set (or with null, unset) a variable in the box's environment. */
	async setEnv(key: string, value: string | null): Promise<void> {
		this.env = await this.rpc.call<Record<string, string>>('env', [key, value]);
	}

	private async run(cmd: string, options: RunOptions = {}): Promise<CommandResult> {
		if (options.signal?.aborted) return { stdout: '', stderr: '', exitCode: 130 };
		const id = this.nextRun++;
		const stream = !!(options.onStdout || options.onStderr);
		if (stream) this.streams.set(id, { onStdout: options.onStdout, onStderr: options.onStderr });
		const onAbort = () => this.rpc.emit('run.abort', id);
		options.signal?.addEventListener('abort', onAbort, { once: true });
		try {
			const r = await this.rpc.call<CommandResult & { cwd: string }>('run', [
				id,
				cmd,
				{ cwd: options.cwd, env: options.env, timeout: options.timeout, stdin: options.stdin, stream },
			]);
			this._cwd = r.cwd;
			return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
		} finally {
			this.streams.delete(id);
			options.signal?.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * Show the box's shell in a terminal in the page: an element or selector (an xterm.js terminal
	 * is made), or your own ITerminal. Attaching again moves the shell.
	 */
	async attach(target: HTMLElement | string | ITerminal, options: { fontSize?: number } = {}): Promise<void> {
		this.detachTerminal();
		let term: ITerminal;
		if (isTerminal(target)) term = target;
		else {
			const { Terminal } = await import('@lifo-sh/ui');
			const t = new Terminal(resolveElement(target), { fontSize: options.fontSize });
			term = t;
			this.ownTerminal = t as { dispose?: () => void };
		}
		this.unwire = wireTerminal(this.rpc, term);
		const motd = await this.rpc.call<string>('attach', [{ cols: term.cols, rows: term.rows }]);
		if (this.ownTerminal) term.write(motd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
		term.focus();
	}

	/** Disconnect the terminal (the box keeps running headless). */
	detach(): void {
		this.detachTerminal();
		void this.rpc.call('detach').catch(() => {});
	}

	/** Tell the box the terminal's new size (terminals without onResize). */
	resize(cols: number, rows: number): void {
		this.rpc.emit('term.resize', { cols, rows });
	}

	private detachTerminal() {
		this.unwire?.();
		this.unwire = null;
		this.ownTerminal?.dispose?.();
		this.ownTerminal = null;
	}

	/** A request to a server in the box (see Sandbox.fetch). */
	async fetch(input: string | URL, init: SandboxFetchInit = {}): Promise<Response> {
		const headers: Array<[string, string]> = [];
		new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => headers.push([k, v]));
		const transferList: Transferable[] = [];
		let body: string | ArrayBuffer | undefined;
		if (init.body != null) {
			if (typeof init.body === 'string') body = init.body;
			else {
				body = (init.body instanceof Uint8Array ? ownBuffer(init.body) : (init.body as ArrayBuffer)).slice(0);
				transferList.push(body);
			}
		}
		const r = await this.rpc.call<{ status: number; statusText: string; headers: Array<[string, string]>; body: ArrayBuffer }>(
			'fetch',
			[String(input), { method: init.method, headers, body, port: init.port, timeout: init.timeout }],
			transferList,
		);
		const nullBody = r.status === 204 || r.status === 304 || (r.status >= 100 && r.status < 200);
		return new Response(nullBody ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
	}

	waitForPort(port: number, options: { timeout?: number } = {}): Promise<void> {
		return this.rpc.call('waitForPort', [port, options]);
	}

	/** Ports servers in the box listen on. */
	ports(): Promise<number[]> {
		return this.rpc.call('ports');
	}

	/** Processes running in the box. */
	processes(): Promise<Array<{ pid: number; command: string; args: string[] }>> {
		return this.rpc.call('processes');
	}

	/** Whether the interactive shell is running a command right now. */
	busy(): Promise<boolean> {
		return this.rpc.call('busy');
	}

	async exportSnapshot(options: SnapshotOptions = {}): Promise<Uint8Array> {
		return new Uint8Array(await this.rpc.call<ArrayBuffer>('exportSnapshot', [options]));
	}

	async importSnapshot(data: Uint8Array): Promise<SnapshotMetadata | null> {
		const buf = ownBuffer(data).slice(0);
		const meta = await this.rpc.call<SnapshotMetadata | null>('importSnapshot', [buf], [buf]);
		this._cwd = await this.rpc.call<string>('cwd');
		await this.getEnv();
		return meta;
	}

	/**
	 * Serve previews from this box: pass one end of a MessageChannel whose other end went to the
	 * preview service worker. Returns the box id the worker routes `/_sw/<boxId>/<port>/` by.
	 * Requests from preview frames are answered inside the box's worker, never by the page.
	 */
	servePreviews(port: MessagePort): Promise<string> {
		return this.rpc.call<string>('previews', [port], [port]);
	}

	/** The box's own origin when it runs on another origin (`host`), else null. Previews live there. */
	get origin(): string | null {
		return this.frame?.origin ?? null;
	}

	/**
	 * For a box on another origin: serve its previews from that origin's service worker and return
	 * the URL prefix for them (`<box origin>/_sw/<boxId>/`; add `<port>/`). Preview pages then run on
	 * the box origin too, never on this site. Re-connects by itself when the service worker restarts.
	 */
	async servePreviewsOnOrigin(): Promise<{ boxId: string; base: string }> {
		const frame = this.frame;
		if (!frame) throw new Error('servePreviewsOnOrigin is for a box created with `host`');
		const channel = new MessageChannel();
		const boxId = await this.servePreviews(channel.port1);
		frame.connectPreviews(boxId, channel.port2);
		this.reannounce ??= frame.onNeedHost(() => {
			if (!this.destroyed) void this.servePreviewsOnOrigin().catch(() => {});
		});
		return { boxId, base: `${frame.origin}/_sw/${boxId}/` };
	}

	/** Stop the box: every process ends and the worker is terminated. */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.detachTerminal();
		this.reannounce?.();
		const end = () => {
			this.rpc.close();
			this.endpoint.terminate?.();
		};
		// Give the box a moment to stop cleanly (close sockets), then terminate either way.
		const t = setTimeout(end, 200);
		void this.rpc.call('destroy').finally(() => {
			clearTimeout(t);
			end();
		});
	}
}
