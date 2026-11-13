/**
 * Lifo services: run a tool on Lifo's servers instead of in the box.
 *
 * A box stays light by not carrying every tool. A job names a tool (`ffmpeg`), its arguments and
 * the files it reads; the service runs it in an isolated container and streams back its output
 * and the files it wrote. Files travel by content hash, so a file the service already has from
 * an earlier job isn't uploaded again.
 *
 * The protocol is plain HTTP (see docs/cloud/services.md): JSON requests and one streamed
 * NDJSON response per job, which works the same from a browser tab, Node.js and a cloud box.
 */

import { DEFAULT_BASE_URL, fetchCliConfig, normalizeBaseUrl } from './auth.js';

export interface ServiceTool {
	name: string;
	version: string;
	description: string;
	limits: { timeoutS: number; cpus: number; memoryMB: number; maxInputMB: number; maxOutputMB: number };
}

export interface ServiceUsage {
	/** CPU time the job used, in ms (wall time when `cpuEstimated`). */
	cpuMs: number;
	wallMs: number;
	bytesIn: number;
	bytesOut: number;
	cpuEstimated?: boolean;
}

export interface ServiceJob {
	tool: string;
	/** Arguments as the tool gets them. Paths must be relative to the job's working directory. */
	args: string[];
	/** Files the job reads, at paths relative to its working directory. */
	files?: { path: string; bytes: Uint8Array }[];
	/** Directories that must exist (most tools won't create an output's folder). */
	dirs?: string[];
	/** The tool's standard input, sent whole before the job starts. */
	stdin?: Uint8Array;
	/** Refuse unless the service has this version of the tool. */
	version?: string;
	signal?: AbortSignal;
	onStdout?: (bytes: Uint8Array) => void;
	onStderr?: (bytes: Uint8Array) => void;
}

export interface ServiceFile {
	path: string;
	sha256: string;
	size: number;
}

export interface ServiceResult {
	exitCode: number;
	/** Why the service stopped the job, if it did. */
	reason?: 'timeout' | 'memory' | 'output-limit' | 'cancelled';
	/** Files the job created or changed. Fetch their bytes with `download()`. */
	files: ServiceFile[];
	usage: ServiceUsage;
	/** What this call had to upload (0 when the service already had every file). */
	uploaded: { files: number; bytes: number };
}

export interface ServicesUsage {
	from: string;
	to: string;
	totals: { jobs: number; cpuMs: number; wallMs: number; bytesIn: number; bytesOut: number };
	tools: { tool: string; jobs: number; cpuMs: number; wallMs: number; bytesIn: number; bytesOut: number }[];
}

export interface BrowserSession {
	box: string;
	/** CDP over WebSocket: `chromium.connectOverCDP(wsEndpoint)`. */
	wsEndpoint: string;
	screencastUrl: string;
	expiresAt: string;
	version: string;
	limits: { maxTabs: number; maxContexts: number; sessionMaxMin: number; idleMin: number; memoryMB: number };
}

export class ServiceError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export class LifoServices {
	readonly url: string;
	private token: string;

	constructor(opts: { token: string; url: string }) {
		this.token = opts.token;
		this.url = opts.url.replace(/\/+$/, '');
	}

	/** Finds the services for an account server (lifo.sh by default) from its /api/cli/config. */
	static async connect(opts: { token: string; baseUrl?: string; url?: string }): Promise<LifoServices> {
		if (opts.url) return new LifoServices({ token: opts.token, url: opts.url });
		const baseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
		const config = await fetchCliConfig(baseUrl);
		if (!config.servicesUrl) throw new Error(`Lifo services aren't available on ${baseUrl} yet`);
		return new LifoServices({ token: opts.token, url: config.servicesUrl });
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${this.token}`);
		let res: Response;
		try {
			res = await fetch(`${this.url}${path}`, { ...init, headers });
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') throw err;
			throw new ServiceError(`Can't reach Lifo services at ${this.url} (${(err as Error).message})`, 0);
		}
		if (!res.ok) {
			let message = `${res.status} ${res.statusText}`;
			try {
				const body = await res.json();
				if (body?.error) message = body.error;
			} catch {
				/* not JSON */
			}
			throw new ServiceError(message, res.status);
		}
		return res;
	}

	private json(path: string, method: string, body?: unknown): Promise<Response> {
		return this.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
	}

	/** The tools this service runs, and the tools this account always allows. */
	async tools(): Promise<{ tools: ServiceTool[]; consent: { tools: string[] } }> {
		return (await this.request('/v1/tools')).json();
	}

	/** Tools this account has said may always receive its files. */
	async consent(): Promise<string[]> {
		return ((await (await this.request('/v1/consent')).json()) as { tools: string[] }).tools;
	}

	async setConsent(tools: string[]): Promise<string[]> {
		return ((await (await this.json('/v1/consent', 'PUT', { tools })).json()) as { tools: string[] }).tools;
	}

	async usage(range: { from?: string | number; to?: string | number } = {}): Promise<ServicesUsage> {
		const q = new URLSearchParams();
		if (range.from != null) q.set('from', String(range.from));
		if (range.to != null) q.set('to', String(range.to));
		return (await this.request(`/v1/usage${q.size ? `?${q}` : ''}`)).json();
	}

	/**
	 * A real Chromium for a box (the Browser service): its browser context is created on first use
	 * and kept until the box has had no client for a few minutes. `wsEndpoint` is a CDP WebSocket
	 * for playwright-core's `connectOverCDP` or puppeteer, good for about 5 minutes to connect;
	 * `screencastUrl` streams the page as JPEG frames and takes input. `state.cookies` restores a
	 * profile the box saved earlier with `browserState`.
	 */
	async browserSession(box: string, opts: { state?: { cookies: unknown[] } } = {}): Promise<BrowserSession> {
		return (await this.json('/v1/browser/sessions', 'POST', { box, ...(opts.state ? { state: opts.state } : {}) })).json();
	}

	/** The box browser's cookies, to save as a file the box owns. */
	async browserState(box: string): Promise<{ cookies: unknown[] }> {
		return (await this.request(`/v1/browser/sessions/${encodeURIComponent(box)}/state`)).json();
	}

	/** Close the box's browser now (it also closes by itself when idle). */
	async closeBrowser(box: string): Promise<boolean> {
		return ((await (await this.request(`/v1/browser/sessions/${encodeURIComponent(box)}`, { method: 'DELETE' })).json()) as { closed: boolean }).closed;
	}

	/** The bytes of a file a job returned (kept by the service for a day). */
	async download(sha256: string): Promise<Uint8Array> {
		return new Uint8Array(await (await this.request(`/v1/blobs/${sha256}`)).arrayBuffer());
	}

	/** Run one job to completion. Rejects only when the job couldn't run; a failing tool resolves with its exit code. */
	async run(job: ServiceJob): Promise<ServiceResult> {
		const inputs = await Promise.all((job.files ?? []).map(async (f) => ({ path: f.path, bytes: f.bytes, sha256: await sha256Hex(f.bytes) })));
		const stdin = job.stdin ? { bytes: job.stdin, sha256: await sha256Hex(job.stdin) } : null;
		const blobs = new Map<string, Uint8Array>();
		for (const f of inputs) blobs.set(f.sha256, f.bytes);
		if (stdin) blobs.set(stdin.sha256, stdin.bytes);

		const uploaded = { files: 0, bytes: 0 };
		if (blobs.size) {
			const { missing } = (await (await this.json('/v1/blobs/check', 'POST', { hashes: [...blobs.keys()] })).json()) as { missing: string[] };
			for (const sha of missing) {
				const bytes = blobs.get(sha)!;
				await this.request(`/v1/blobs/${sha}`, { method: 'PUT', body: bytes as unknown as BodyInit, signal: job.signal });
				uploaded.files++;
				uploaded.bytes += bytes.length;
			}
		}

		const res = await this.request('/v1/jobs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: job.signal,
			body: JSON.stringify({
				tool: job.tool,
				args: job.args,
				files: inputs.map((f) => ({ path: f.path, sha256: f.sha256 })),
				dirs: job.dirs ?? [],
				...(stdin ? { stdin: { sha256: stdin.sha256 } } : {}),
				...(job.version ? { version: job.version } : {}),
			}),
		});

		const files: ServiceFile[] = [];
		let exit: { code: number; reason?: ServiceResult['reason']; usage: ServiceUsage } | null = null;
		let failure: string | null = null;
		const onEvent = (line: string) => {
			if (!line) return;
			const ev = JSON.parse(line) as { t: string; b?: string; path?: string; sha256?: string; size?: number; code?: number; reason?: ServiceResult['reason']; usage?: ServiceUsage; message?: string };
			if (ev.t === 'o') job.onStdout?.(fromBase64(ev.b!));
			else if (ev.t === 'e') job.onStderr?.(fromBase64(ev.b!));
			else if (ev.t === 'file') files.push({ path: ev.path!, sha256: ev.sha256!, size: ev.size! });
			else if (ev.t === 'exit') exit = { code: ev.code!, reason: ev.reason, usage: ev.usage! };
			else if (ev.t === 'error') failure = ev.message ?? 'The job failed on the server.';
		};

		// One JSON event per line, as they happen. Hosts without a streaming body get them at the end.
		const reader = res.body?.getReader?.();
		if (reader) {
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					onEvent(buf.slice(0, nl));
					buf = buf.slice(nl + 1);
				}
			}
			onEvent(buf.trim());
		} else {
			for (const line of (await res.text()).split('\n')) onEvent(line);
		}

		if (failure) throw new ServiceError(failure, 500);
		if (!exit) throw new ServiceError('The connection to Lifo services ended before the job finished.', 0);
		const done = exit as { code: number; reason?: ServiceResult['reason']; usage: ServiceUsage };
		return { exitCode: done.code, ...(done.reason ? { reason: done.reason } : {}), files, usage: done.usage, uploaded };
	}
}
