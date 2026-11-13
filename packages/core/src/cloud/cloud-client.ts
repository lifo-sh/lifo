/**
 * cloud/cloud-client.ts — move a box to Lifo Cloud and work with it there.
 *
 * A box in a browser tab or a Node process is a snapshot away from running somewhere that stays
 * up: `push` uploads its snapshot with a start command and a port, the cloud boots it in its own
 * isolate, runs the command and gives the port a public URL (the same tunnel URLs `lifo tunnel`
 * uses). Cloud boxes sleep when idle and wake on the next request with their files as written; `pull`
 * brings one back into a local box.
 *
 *   const cloud = await LifoCloud.connect({ token });             // a lifo_ key
 *   const { box: info } = await cloud.push('my-api', box, { start: 'node server.js', port: 3000 });
 *   info.url                                                      // https://my-api-tunnel.lifo.sh
 *   await cloud.exec('my-api', 'ls');                             // { stdout, stderr, exitCode }
 *   await box.importSnapshot(await cloud.pull('my-api'));         // and back
 *   const sh = await cloud.shell('my-api', { cols: 80, rows: 24 }); // an interactive shell there
 */

import { fetchCliConfig, DEFAULT_BASE_URL, normalizeBaseUrl } from './auth.js';

export interface CloudBoxInfo {
	name: string;
	port: number | null;
	start: string;
	/** Public URL, when the box has a port and its tunnel is up. */
	url: string | null;
	createdAt: string;
	updatedAt: string;
	/** When it was last pushed or checkpointed (`save`). Its files are written through as they change. */
	savedAt: string;
	snapshotBytes: number;
	/** Seconds without traffic, commands or shell input before the box sleeps (scales to zero); null = never. */
	sleepAfter: number | null;
	/** Whether the box has a running isolate right now. */
	awake: boolean;
	/** When it last woke (ms since epoch), while awake. */
	since: number | null;
	/** What runs it: `workerd` (a Lifo box, the default) or `container` (a real Linux container). */
	runtime?: CloudRuntime;
	/** Why it runs there (the push's choice, or what `auto` found: a Dockerfile, native npm packages, ...). */
	runtimeReason?: string | null;
}

/** Where a cloud box runs: a Lifo box on workerd, or a real Linux container (when it needs native code). */
export type CloudRuntime = 'workerd' | 'container';

export type CloudMetricsRange = '1h' | '6h' | '24h' | '7d' | '30d';

/** One step of a box's usage (step = 60 s for 1h/6h, 300 s for 24h, 3600 s for 7d/30d). */
export interface CloudMetricsPoint {
	/** Start of the step, ms since epoch. */
	t: number;
	/** CPU time the box's isolate spent running JavaScript (and GC). */
	cpuMs: number;
	/** Time spent answering its requests and commands. */
	wallMs: number;
	requests: number;
	/** Responses with a 5xx status. */
	errors: number;
	bytesIn: number;
	bytesOut: number;
	/** Peak memory of the box's isolate (V8 heap + ArrayBuffers, which hold its files). */
	memMB: number;
	/** Fraction of the step the box was awake, 0 to 1. */
	awake: number;
}

export interface CloudMetrics {
	range: CloudMetricsRange;
	step: number;
	points: CloudMetricsPoint[];
	/** True when the cloud can't read the isolate's heap and memMB is an estimate. */
	memEstimated: boolean;
	uptime: {
		awake: boolean;
		since: number | null;
		lastWake: number | null;
		lastSleep: number | null;
		bootCount: number;
		/** Seconds awake within the range. */
		awakeSeconds: number;
	};
	settings: { sleepAfter: number | null };
	storageBytes: number;
}

export interface CloudEvent {
	t: number;
	type: 'boot' | 'sleep' | 'push' | 'restart' | 'error' | 'config';
	/** boot: push, request, exec, shell, restart, always-on. sleep: idle, push, restart, delete, admin, evicted, node-restart, shutdown. */
	reason?: string | null;
	detail?: string | null;
}

/** Usage totals: the units billing is computed from. */
export interface CloudUsageTotals {
	awakeSeconds: number;
	cpuMs: number;
	requests: number;
	bytesOut: number;
	bytesIn: number;
	/** Snapshot storage, in GB (10^9 bytes) × hours. */
	storageGBHours: number;
}

export interface CloudUsage {
	from: string;
	to: string;
	totals: CloudUsageTotals;
	boxes: Array<{ name: string } & CloudUsageTotals>;
}

export interface CloudPushOptions {
	/** Command that starts the box's app, run in the background on every wake. */
	start?: string;
	/** Port the app listens on; it gets the public URL. */
	port?: number;
	/** Working directory for `start` and `exec` (default /home/user). */
	cwd?: string;
	/** Environment for the box. */
	env?: Record<string, string>;
	/** Path segments to leave out of the snapshot, e.g. ['node_modules']. `.lifo` is always left out. */
	exclude?: string[];
	/** Seconds idle before the box sleeps (default 300, 60 to 86400); null = never (always-on, when your plan allows it). */
	sleepAfter?: number | null;
	/**
	 * `workerd` (a Lifo box), `container` (a real Linux container), or `auto` (the default): a
	 * container when the box needs one (a Dockerfile, native npm packages, binaries Lifo lacks).
	 */
	runtime?: CloudRuntime | 'auto';
}

/** Anything that can produce a snapshot: a Sandbox, or the bytes themselves. */
export type SnapshotSource =
	| Uint8Array
	| {
			exportSnapshot(options?: { exclude?: string[]; metadata?: { env?: Record<string, string> } }): Promise<Uint8Array>;
			env?: Record<string, string>;
	  };

export interface CloudExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * An interactive shell in a cloud box (`LifoCloud.shell`): keystrokes in, terminal output out.
 * Wire it to a terminal: `term.onData(d => sh.write(d))`, `sh.onData(d => term.write(d))`.
 */
export interface CloudShell {
	/** Send keystrokes (as a terminal produces them: '\r' for Enter, '\x03' for Ctrl+C). */
	write(data: string): void;
	/** Tell the box the terminal's size ($COLUMNS, $LINES, full-screen programs). */
	resize(cols: number, rows: number): void;
	/** Terminal output. Output that arrived before the first listener is replayed to it. */
	onData(cb: (data: string) => void): void;
	/**
	 * The shell ended: 1000 after `exit`; 4401 not logged in, 4403 not your box, 4404 no such box,
	 * 1011 the box couldn't start a shell; 1006 the connection dropped.
	 */
	onClose(cb: (code: number, reason: string) => void): void;
	/** Disconnect. The box keeps running; its other shells and its app aren't affected. */
	close(): void;
}

/** The parts of the WebSocket API LifoCloud.shell uses (the browser's, Node 22+'s, or `ws`). */
export type WebSocketLike = {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
};
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Credentials never travel in a snapshot: the login file and the keys passed in by the CLI. */
export const CLOUD_ALWAYS_EXCLUDE = ['.lifo'];
const SECRET_ENV = /^(LIFO_AUTH_TOKEN|LIFO_BASE_URL|LIFO_TUNNEL_URL|LIFO_CLOUD_URL)$/;
/** A cloud box's own database (the cloud sets DATABASE_URL to it at every boot; it carries a password). */
const CLOUD_DB_URL = /^postgres(?:ql)?:\/\/[^@]*@db\.lifo\.internal[:/]/;

export function cloudSafeEnv(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) && !CLOUD_DB_URL.test(String(v))) out[k] = v;
	return out;
}

export class LifoCloud {
	readonly url: string;
	private token: string;

	constructor(opts: { token: string; url: string }) {
		this.token = opts.token;
		this.url = opts.url.replace(/\/$/, '');
	}

	/** Finds the cloud for an account server (lifo.sh by default) from its /api/cli/config. */
	static async connect(opts: { token: string; baseUrl?: string; url?: string }): Promise<LifoCloud> {
		if (opts.url) return new LifoCloud({ token: opts.token, url: opts.url });
		const baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
		const config = await fetchCliConfig(baseUrl);
		if (!config.cloudUrl) throw new Error(`Lifo Cloud isn't available on ${baseUrl} yet`);
		return new LifoCloud({ token: opts.token, url: config.cloudUrl });
	}

	private async request(path: string, init: RequestInit = {}, prefix = '/v1/boxes'): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${this.token}`);
		const res = await fetch(`${this.url}${prefix}${path}`, { ...init, headers });
		if (!res.ok) {
			let message = `${res.status} ${res.statusText}`;
			try {
				const body = await res.json();
				if (body?.error) message = body.error;
			} catch {
				/* not JSON */
			}
			throw new Error(message);
		}
		return res;
	}

	private async json<T>(path: string, init?: RequestInit): Promise<T> {
		return (await this.request(path, init)).json() as Promise<T>;
	}

	/** Upload a box (or snapshot bytes) as the cloud box `name`, replacing any previous push. */
	async push(name: string, source: SnapshotSource, opts: CloudPushOptions = {}): Promise<{ box: CloudBoxInfo; boot: { bootMs: number; listening: boolean } }> {
		const snapshot =
			source instanceof Uint8Array
				? source
				: await source.exportSnapshot({
						exclude: [...CLOUD_ALWAYS_EXCLUDE, ...(opts.exclude ?? [])],
						// The manifest carries the box's env; keys passed in by the CLI stay here.
						...(source.env ? { metadata: { env: cloudSafeEnv(source.env) } } : {}),
					});
		const meta = {
			start: opts.start ?? '',
			port: opts.port ?? null,
			cwd: opts.cwd,
			env: opts.env ? cloudSafeEnv(opts.env) : undefined,
			...(opts.sleepAfter !== undefined ? { sleepAfter: opts.sleepAfter } : {}),
			...(opts.runtime ? { runtime: opts.runtime } : {}),
		};
		return this.json(`/${encodeURIComponent(name)}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/gzip', 'x-lifo-box': JSON.stringify(meta) },
			body: snapshot as BodyInit,
		});
	}

	async list(): Promise<CloudBoxInfo[]> {
		return (await this.json<{ boxes: CloudBoxInfo[] }>('')).boxes;
	}

	async get(name: string): Promise<{ box: CloudBoxInfo; status: { awake: boolean; listening: boolean; exitCode: number | null } }> {
		return this.json(`/${encodeURIComponent(name)}`);
	}

	/** Run a shell line in the cloud box (it wakes if asleep). */
	async exec(name: string, cmd: string, opts: { cwd?: string; timeout?: number } = {}): Promise<CloudExecResult> {
		return this.json(`/${encodeURIComponent(name)}/exec`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cmd, ...opts }),
		});
	}

	/** Snapshot the running cloud box now, so a wake starts from this state. */
	async save(name: string): Promise<{ saved: boolean; snapshotBytes: number }> {
		return this.json(`/${encodeURIComponent(name)}/save`, { method: 'POST' });
	}

	/** The cloud box as a snapshot, for `box.importSnapshot()` here. */
	async pull(name: string): Promise<Uint8Array> {
		return new Uint8Array(await (await this.request(`/${encodeURIComponent(name)}/snapshot`)).arrayBuffer());
	}

	/**
	 * The box database's app data (its public schema) as SQL INSERTs, or null when the box has no
	 * database yet. Appended to supabase/seed.sql, it loads into tinbase in a tab.
	 */
	async dataSql(name: string): Promise<string | null> {
		const res = await fetch(`${this.url}/v1/boxes/${encodeURIComponent(name)}/data.sql`, { headers: { authorization: `Bearer ${this.token}` } });
		if (res.status === 404) {
			const body = await res.json().catch(() => ({}) as { error?: string });
			if (/no database yet/.test(String(body.error))) return null;
			throw new Error(body.error || `HTTP 404`);
		}
		if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${res.status}`);
		return res.text();
	}

	/** Output of the start command. */
	async logs(name: string): Promise<string> {
		return (await this.request(`/${encodeURIComponent(name)}/logs`)).text();
	}

	/** A fresh isolate on the same files, running the start command again. */
	async restart(name: string): Promise<{ box: CloudBoxInfo }> {
		return this.json(`/${encodeURIComponent(name)}/restart`, { method: 'POST' });
	}

	async remove(name: string): Promise<void> {
		await this.request(`/${encodeURIComponent(name)}`, { method: 'DELETE' });
	}

	/** Usage over time (CPU, requests, bytes, memory, awake), uptime and the sleep setting. */
	async metrics(name: string, range: CloudMetricsRange = '1h'): Promise<CloudMetrics> {
		return this.json(`/${encodeURIComponent(name)}/metrics?range=${encodeURIComponent(range)}`);
	}

	/** Recent boots, sleeps, pushes, restarts, setting changes and errors, newest first. */
	async events(name: string, limit = 50): Promise<CloudEvent[]> {
		return (await this.json<{ events: CloudEvent[] }>(`/${encodeURIComponent(name)}/events?limit=${limit}`)).events;
	}

	/**
	 * Change a box's settings: sleepAfter in seconds (scale to zero), or null for never; runtime moves
	 * the box (and its files) between workerd and a container.
	 */
	async update(name: string, settings: { sleepAfter?: number | null; runtime?: CloudRuntime }): Promise<{ box: CloudBoxInfo }> {
		return this.json(`/${encodeURIComponent(name)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(settings),
		});
	}

	/** This account's usage totals, per box, for a period (default: this calendar month, UTC). */
	async usage(period: { from?: string | number | Date; to?: string | number | Date } = {}): Promise<CloudUsage> {
		const q = new URLSearchParams();
		const iso = (v: string | number | Date) => (v instanceof Date ? v.toISOString() : String(v));
		if (period.from !== undefined) q.set('from', iso(period.from));
		if (period.to !== undefined) q.set('to', iso(period.to));
		const qs = q.toString();
		const res = await this.request(qs ? `?${qs}` : '', {}, '/v1/usage');
		return res.json() as Promise<CloudUsage>;
	}

	/** The WebSocket URL of a cloud box's shell (see `shell`). The key goes in the subprotocols. */
	shellUrl(name: string, size: { cols?: number; rows?: number } = {}): string {
		const q = new URLSearchParams({ cols: String(Math.round(size.cols ?? 80)), rows: String(Math.round(size.rows ?? 24)) });
		return `${this.url.replace(/^http/, 'ws')}/v1/boxes/${encodeURIComponent(name)}/shell?${q}`;
	}

	/**
	 * Open an interactive shell in the cloud box `name` (it wakes if asleep): the same files,
	 * environment and processes as its app, with its own prompt and working directory. Resolves
	 * once connected; rejects (with `.code` 4401, 4403, 4404, 1011 or 1006) if the cloud
	 * refuses or the connection fails. Later ends (`exit`, a dropped connection) arrive through
	 * `onClose`.
	 *
	 * Works in browsers and Node 22+ with the global WebSocket; pass `WebSocket` (e.g. from `ws`)
	 * elsewhere. The key travels as the subprotocol `lifo-token.<key>`, because browsers can't
	 * set headers on a WebSocket.
	 */
	shell(name: string, opts: { cols?: number; rows?: number; WebSocket?: WebSocketConstructor } = {}): Promise<CloudShell> {
		const WS = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
		if (!WS) return Promise.reject(new Error('LifoCloud.shell needs a WebSocket (Node 22+, a browser, or pass one in)'));
		const ws = new WS(this.shellUrl(name, opts), ['lifo-shell', `lifo-token.${this.token}`]);
		const dataListeners: ((data: string) => void)[] = [];
		const closeListeners: ((code: number, reason: string) => void)[] = [];
		const early: string[] = [];
		let closed: { code: number; reason: string } | null = null;
		const decoder = new TextDecoder();
		const shell: CloudShell = {
			write(data) {
				if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: data }));
			},
			resize(cols, rows) {
				if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: Math.round(cols), r: Math.round(rows) }));
			},
			onData(cb) {
				dataListeners.push(cb);
				if (dataListeners.length === 1) for (const d of early.splice(0)) cb(d);
			},
			onClose(cb) {
				closeListeners.push(cb);
				if (closed) cb(closed.code, closed.reason);
			},
			close() {
				if (ws.readyState <= 1) ws.close(1000, 'bye');
			},
		};
		// The cloud sends its first frame (a banner) only after the key and the owner check out,
		// so that's "connected"; a close before it is a refusal (4401, 4403, 4404) and rejects.
		return new Promise((resolve, reject) => {
			let ready = false;
			ws.addEventListener('message', (e) => {
				const d = typeof e.data === 'string' ? e.data : decoder.decode(e.data as ArrayBuffer);
				if (dataListeners.length) for (const cb of dataListeners) cb(d);
				else early.push(d);
				if (!ready) {
					ready = true;
					resolve(shell);
				}
			});
			ws.addEventListener('close', (e) => {
				closed = { code: e.code ?? 1006, reason: e.reason ?? '' };
				if (!ready) {
					ready = true;
					reject(Object.assign(new Error(closed.reason || `Couldn't open a shell in "${name}" (${closed.code})`), { code: closed.code }));
					return;
				}
				for (const cb of closeListeners) cb(closed.code, closed.reason);
			});
		});
	}
}
