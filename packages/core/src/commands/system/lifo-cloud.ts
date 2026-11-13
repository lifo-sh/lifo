/**
 * lifo login | logout | whoami | tunnel | cloud — inside a box.
 *
 * The same commands as the host CLI (`npx lifo-sh login`, ...), working from the
 * box's own filesystem and network: credentials live in ~/.lifo/auth.json inside
 * the box, and `lifo tunnel <port>` shares a server running in the box.
 *
 * Login inside a box always uses the paste-a-code flow: a box in a browser tab
 * can't listen on a loopback port for the redirect. When the host CLI boots a box
 * it passes its own login in (LIFO_AUTH_TOKEN, LIFO_BASE_URL), so there's usually
 * nothing to do.
 */

import type { CommandContext } from '../types.js';
import type { VFS } from '../../kernel/vfs/index.js';
import type { VirtualRequestHandler } from '../../kernel/index.js';
import {
	createPkce,
	exchangeCode,
	fetchCliConfig,
	fetchMe,
	loadAuth,
	loginUrl,
	normalizeBaseUrl,
	removeSession,
	resolveBaseUrl,
	revokeToken,
	saveSession,
	type AuthStore,
} from '../../cloud/auth.js';
import { runTunnel } from '../../cloud/tunnel-client.js';
import { LifoCloud, CLOUD_ALWAYS_EXCLUDE, cloudSafeEnv } from '../../cloud/cloud-client.js';
import { createShellEscape } from '../../cloud/shell-escape.js';
import { exportVfsSnapshot, importVfsSnapshot } from '../../kernel/vfs/snapshot.js';
import { createVmForwarder } from '../../cloud/vm-forwarder.js';
import { boxAuthBaseUrl, clearBoxAuthToken, getBoxAuthToken } from '../../cloud/box-auth.js';

function boxStore(vfs: VFS, home: string): AuthStore {
	const dir = `${home}/.lifo`;
	const file = `${dir}/auth.json`;
	return {
		async read() {
			return vfs.exists(file) ? vfs.readFileString(file) : null;
		},
		async write(data) {
			if (!vfs.exists(dir)) vfs.mkdir(dir, { recursive: true });
			vfs.writeFile(file, data);
		},
	};
}

/** Pulls `--base-url <url>` / `--base-url=<url>` (and `--local`) out of args. */
function takeBaseUrlFlag(args: string[]): { flag?: string; rest: string[] } {
	const rest: string[] = [];
	let flag: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--base-url' && args[i + 1]) flag = args[++i];
		else if (a.startsWith('--base-url=')) flag = a.slice('--base-url='.length);
		else if (a === '--local') flag = 'http://localhost:3000';
		else rest.push(a);
	}
	return { flag, rest };
}

export interface Resolved {
	baseUrl: string;
	token: string | null;
	email: string | null;
	/** The login of the lifo CLI that started this box (LIFO_AUTH_TOKEN). */
	fromEnv: boolean;
	/** The login of the page or app that created this box (`Sandbox.create({ auth })`). */
	fromPage: boolean;
	store: AuthStore;
}

/**
 * Which login a command uses. The website: `--base-url`, then the page's (Sandbox auth), then
 * LIFO_BASE_URL, then the last login. The token: the page's when it's for that website and the
 * page has one, then the host CLI's (LIFO_AUTH_TOKEN), then ~/.lifo/auth.json.
 */
export async function resolve(ctx: CommandContext, flag?: string): Promise<Resolved> {
	const store = boxStore(ctx.vfs, ctx.env.HOME || '/home/user');
	const file = await loadAuth(store);
	const pageBase = boxAuthBaseUrl(ctx.vfs);
	const baseUrl = flag ? normalizeBaseUrl(flag) : (pageBase ?? resolveBaseUrl({ env: ctx.env.LIFO_BASE_URL, file }));
	const base = { baseUrl, email: null, fromEnv: false, fromPage: false, store };
	if (pageBase && pageBase === baseUrl) {
		const token = await getBoxAuthToken(ctx.vfs);
		if (token) return { ...base, token, fromPage: true };
	}
	const envToken = ctx.env.LIFO_AUTH_TOKEN;
	// The host CLI's login, passed in when it booted this box; it belongs to LIFO_BASE_URL.
	const envBase = ctx.env.LIFO_BASE_URL ? normalizeBaseUrl(ctx.env.LIFO_BASE_URL) : null;
	if (envToken && (envBase ? envBase === baseUrl : !flag && !pageBase)) {
		return { ...base, token: envToken, fromEnv: true };
	}
	const s = file.sessions[baseUrl];
	return { ...base, token: s?.token ?? null, email: s?.email ?? null };
}

export async function readLine(ctx: CommandContext): Promise<string | null> {
	if (!ctx.stdin) return null;
	let buf = '';
	while (!ctx.signal.aborted) {
		const chunk = await ctx.stdin.read();
		if (chunk === null) break;
		buf += chunk;
		const nl = buf.search(/[\r\n]/);
		if (nl >= 0) return buf.slice(0, nl);
	}
	return buf || null;
}

function clientName(ctx: CommandContext): string {
	const where = typeof window !== 'undefined' && typeof document !== 'undefined' ? 'browser' : 'node';
	return `Lifo box (${ctx.env.HOSTNAME || 'lifo'}, ${where})`;
}

export async function lifoLogin(ctx: CommandContext): Promise<number> {
	const { flag } = takeBaseUrlFlag(ctx.args.slice(1));
	const r = await resolve(ctx, flag);

	if (r.fromPage) {
		const me = await fetchMe(r.baseUrl, r.token!).catch(() => null);
		if (me) {
			ctx.stdout.write(`This terminal already uses your login on ${r.baseUrl} (${me.email}).\n`);
			return 0;
		}
	}
	if (r.token && !r.fromEnv && !r.fromPage) {
		const me = await fetchMe(r.baseUrl, r.token).catch(() => null);
		if (me) {
			ctx.stdout.write(`Already logged in to ${r.baseUrl} as ${me.email}. Run 'lifo logout' first to switch accounts.\n`);
			return 0;
		}
	}

	const pkce = await createPkce();
	const client = clientName(ctx);
	const url = loginUrl(r.baseUrl, { challenge: pkce.challenge, state: pkce.state, client });

	ctx.stdout.write(`Log in to ${r.baseUrl} in your browser:\n\n  \x1b]8;;${url}\x1b\\\x1b[34m${url}\x1b[0m\x1b]8;;\x1b\\\n\n`);
	if (typeof window !== 'undefined' && typeof window.open === 'function') {
		try {
			window.open(url, '_blank', 'noopener');
		} catch {
			/* popup blocked; the link is printed above */
		}
	}
	ctx.stdout.write('Approve the login, then paste the code shown on the page: ');
	const code = (await readLine(ctx))?.trim();
	if (!code) {
		ctx.stderr.write('\nlifo login: no code entered\n');
		return 1;
	}

	try {
		const { token, email } = await exchangeCode(r.baseUrl, { code, verifier: pkce.verifier, client });
		await saveSession(r.store, r.baseUrl, { token, email, savedAt: new Date().toISOString() });
		ctx.stdout.write(`\nLogged in to ${r.baseUrl} as ${email}.\n`);
		return 0;
	} catch (e) {
		ctx.stderr.write(`\nlifo login: ${(e as Error).message}\n`);
		return 1;
	}
}

export async function lifoLogout(ctx: CommandContext): Promise<number> {
	const { flag } = takeBaseUrlFlag(ctx.args.slice(1));
	const r = await resolve(ctx, flag);
	if (r.fromPage) {
		ctx.stdout.write(`This terminal uses your login on ${r.baseUrl}, from the page. Log out on the website to end it.\n`);
		return 0;
	}
	if (r.fromEnv) {
		ctx.stdout.write('This box uses the login of the lifo CLI that started it. Run `lifo-sh logout` on the host.\n');
		return 0;
	}
	if (!r.token) {
		ctx.stdout.write(`Not logged in to ${r.baseUrl}.\n`);
		return 0;
	}
	const revoked = await revokeToken(r.baseUrl, r.token);
	await removeSession(r.store, r.baseUrl);
	ctx.stdout.write(`Logged out of ${r.baseUrl}${revoked ? '' : ' (could not reach it to revoke the key; remove it under API keys on the dashboard)'}.\n`);
	return 0;
}

export async function lifoWhoami(ctx: CommandContext): Promise<number> {
	const { flag } = takeBaseUrlFlag(ctx.args.slice(1));
	const r = await resolve(ctx, flag);
	if (!r.token) {
		ctx.stdout.write(`Not logged in to ${r.baseUrl}. Run 'lifo login'.\n`);
		return 1;
	}
	try {
		const me = await fetchMe(r.baseUrl, r.token);
		if (!me) {
			if (r.fromPage) {
				clearBoxAuthToken(ctx.vfs);
				ctx.stdout.write(`This page's login for ${r.baseUrl} has expired. Reload the page, or run 'lifo login'.\n`);
				return 1;
			}
			ctx.stdout.write(`The saved key for ${r.baseUrl} is no longer valid. Run 'lifo login'.\n`);
			return 1;
		}
		ctx.stdout.write(`${me.email} (${r.baseUrl}${r.fromPage ? ", from this page's login" : ''})\n`);
		return 0;
	} catch (e) {
		ctx.stderr.write(`lifo whoami: could not reach ${r.baseUrl}: ${(e as Error).message}\n`);
		return 1;
	}
}

const TUNNEL_USAGE = `Usage: lifo tunnel <port> [--name <name>] [--base-url <url>]

Share a server running in this box on a public URL.

  lifo tunnel 5173               https://<random>-tunnel.lifo.sh -> port 5173
  lifo tunnel 3000 --name demo   https://demo-tunnel.lifo.sh     -> port 3000

Needs 'lifo login'. Ctrl+C stops it.
`;

export async function lifoTunnel(
	ctx: CommandContext,
	portRegistry: Map<number, VirtualRequestHandler> | undefined,
): Promise<number> {
	const { flag, rest } = takeBaseUrlFlag(ctx.args.slice(1));
	let name: string | undefined;
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '-h' || rest[i] === '--help') {
			ctx.stdout.write(TUNNEL_USAGE);
			return 0;
		}
		if ((rest[i] === '--name' || rest[i] === '-n') && rest[i + 1]) name = rest[++i];
		else if (rest[i].startsWith('--name=')) name = rest[i].slice('--name='.length);
		else positional.push(rest[i]);
	}
	const port = Number(positional[0]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		ctx.stderr.write(TUNNEL_USAGE);
		return 1;
	}
	if (!portRegistry) {
		ctx.stderr.write('lifo tunnel: this box has no network stack\n');
		return 1;
	}

	const r = await resolve(ctx, flag);
	if (!r.token) {
		ctx.stderr.write(`lifo tunnel: not logged in to ${r.baseUrl}. Run 'lifo login' first.\n`);
		return 1;
	}

	let tunnelUrl = ctx.env.LIFO_TUNNEL_URL;
	if (!tunnelUrl) {
		try {
			tunnelUrl = (await fetchCliConfig(r.baseUrl)).tunnelUrl;
		} catch (e) {
			ctx.stderr.write(`lifo tunnel: ${(e as Error).message}\n`);
			return 1;
		}
	}

	if (!portRegistry.has(port)) {
		ctx.stdout.write(`Nothing is listening on port ${port} yet; requests will get a 502 until something does.\n`);
	}
	ctx.stdout.write(`Connecting to ${tunnelUrl}...\n`);

	return runTunnel({
		url: tunnelUrl,
		token: r.token,
		// A page's login is short-lived; reconnects ask the page for a current one.
		getToken: r.fromPage ? () => getBoxAuthToken(ctx.vfs) : undefined,
		port,
		name,
		client: clientName(ctx),
		forwarder: createVmForwarder(portRegistry, port),
		signal: ctx.signal,
		onReady: ({ url }) => {
			ctx.stdout.write(`\n  \x1b[32m●\x1b[0m ${url}  ->  port ${port} in this box\n\n  Ctrl+C to stop.\n\n`);
		},
		onRequest: (line) => ctx.stdout.write(`  ${line}`),
		onStatus: (line) => ctx.stderr.write(line),
	});
}

const CLOUD_USAGE = `Usage: lifo cloud <command> [--base-url <url>]

Run this box on Lifo Cloud: it keeps running after this tab or process closes, with a public URL.

  lifo cloud push <name> [--start "<cmd>"] [--port <n>] [--exclude a,b] [--sleep-after 10m]
                   [--runtime auto|workerd|container]
                               upload this box and start it (start defaults to \`npm start\`
                               when ./package.json has a start script)
  lifo cloud ls                your cloud boxes
  lifo cloud status <name>     awake or asleep, its URL
  lifo cloud stats <name> [--range 1h|6h|24h|7d|30d]
                               CPU, requests, memory and uptime over time
  lifo cloud config <name> [--sleep-after <30m|1h|...>] [--runtime workerd|container]
                               how long it may sit idle before it sleeps (scales to zero)
  lifo cloud usage [--from <date>] [--to <date>]
                               this account's usage (default: this month)
  lifo cloud exec <name> <cmd> run a command there
  lifo cloud shell <name>      an interactive shell there (~. on a new line disconnects)
  lifo cloud logs <name>       output of the start command
  lifo cloud save <name>       keep a checkpoint copy (files are saved as they change)
  lifo cloud pull <name> [--with-data]   bring its files back into this box (and its database's data as SQL)
  lifo cloud restart <name>    restart its processes (same files)
  lifo cloud rm <name>         delete it

Needs 'lifo login'. Cloud boxes sleep after 5 idle minutes (change it with --sleep-after) and
wake on the next request.
`;

/** "90", "90s", "10m", "2h", "1d" -> seconds; "never" -> null; anything else -> undefined. */
export function parseDuration(v: string | undefined): number | null | undefined {
	if (v === undefined) return undefined;
	if (v === 'never') return null;
	const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(v.trim());
	if (!m) return undefined;
	return Math.round(Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || 's') as 's' | 'm' | 'h' | 'd']);
}

export function fmtDuration(sec: number | null): string {
	if (sec === null) return 'never';
	if (sec < 60) return `${Math.round(sec)}s`;
	if (sec < 3600) return `${+(sec / 60).toFixed(1)}m`;
	if (sec < 86400) return `${+(sec / 3600).toFixed(1)}h`;
	return `${+(sec / 86400).toFixed(1)}d`;
}

/** Values as a one-line chart of at most `width` cells (each cell sums its share of points). */
export function sparkline(values: number[], width = 48): string {
	if (!values.length) return '';
	const per = Math.max(1, Math.ceil(values.length / width));
	const cells: number[] = [];
	for (let i = 0; i < values.length; i += per) cells.push(values.slice(i, i + per).reduce((a, b) => a + b, 0));
	const max = Math.max(...cells);
	const bars = '▁▂▃▄▅▆▇█';
	return cells.map((v) => (max <= 0 || v <= 0 ? ' ' : bars[Math.min(7, Math.floor((v / max) * 7.999))])).join('');
}

function fmtCount(n: number): string {
	return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}


function fmtBytes(n: number): string {
	if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function ago(iso: string | undefined): string {
	if (!iso) return '-';
	const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

/**
 * `lifo cloud shell <name>` inside a box: this terminal becomes the cloud box's terminal until
 * `exit` there or `~.` on a new line. Keys go over raw, so Ctrl+C reaches the cloud box, as
 * with ssh.
 */
async function cloudShell(ctx: CommandContext, cloud: LifoCloud, name: string): Promise<number> {
	if (!ctx.stdin) {
		ctx.stderr.write('lifo cloud shell: needs a terminal; use lifo cloud exec for one command\n');
		return 1;
	}
	const sh = await cloud.shell(name, { cols: Number(ctx.env.COLUMNS) || 80, rows: Number(ctx.env.LINES) || 24 });
	const raw = !!ctx.setRawMode;
	ctx.setRawMode?.(true);
	const escape = createShellEscape();
	let ended: { code: number; reason: string } | null = null;
	const done = new Promise<void>((resolve) =>
		sh.onClose((code, reason) => {
			ended = { code, reason };
			resolve();
		}),
	);
	sh.onData((d) => ctx.stdout.write(d));
	const onAbort = () => sh.close();
	ctx.signal.addEventListener('abort', onAbort);
	try {
		while (!ended) {
			const chunk = await Promise.race([ctx.stdin.read(), done.then(() => null)]);
			if (chunk === null) break;
			// Without raw mode the box hands over whole lines; Enter is \r to a terminal.
			const { send, disconnect } = escape(raw ? chunk : chunk.replace(/\n/g, '\r'));
			if (send) sh.write(send);
			if (disconnect) {
				sh.close();
				ctx.stdout.write(`\r\nDisconnected from ${name}. It keeps running.\r\n`);
				return 0;
			}
		}
		if (!ended) sh.close();
	} finally {
		ctx.signal.removeEventListener('abort', onAbort);
		ctx.setRawMode?.(false);
	}
	const end = ended as { code: number; reason: string } | null;
	if (!end || end.code === 1000) return 0;
	ctx.stderr.write(`\r\nlifo cloud shell: ${end.reason || `connection closed (${end.code})`}\n`);
	return 1;
}

export async function lifoCloudCommand(ctx: CommandContext): Promise<number> {
	const { flag, rest } = takeBaseUrlFlag(ctx.args.slice(1));
	const sub = rest[0];
	if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
		ctx.stdout.write(CLOUD_USAGE);
		return sub ? 0 : 1;
	}
	const r = await resolve(ctx, flag);
	if (!r.token) {
		ctx.stderr.write(`lifo cloud: not logged in to ${r.baseUrl}. Run 'lifo login' first.\n`);
		return 1;
	}
	let cloud: LifoCloud;
	try {
		cloud = await LifoCloud.connect({ token: r.token, baseUrl: r.baseUrl, url: ctx.env.LIFO_CLOUD_URL || undefined });
	} catch (e) {
		ctx.stderr.write(`lifo cloud: ${(e as Error).message}\n`);
		return 1;
	}

	const args = rest.slice(1);
	const name = args[0];
	const needName = (): boolean => {
		if (name && !name.startsWith('-')) return true;
		ctx.stderr.write(`lifo cloud ${sub}: name the box, e.g. lifo cloud ${sub} my-app\n`);
		return false;
	};

	try {
		switch (sub) {
			case 'push': {
				if (!needName()) return 1;
				let start: string | undefined;
				let port: number | undefined;
				let exclude: string[] = [];
				let sleepAfter: number | null | undefined;
				let runtime: 'auto' | 'workerd' | 'container' | undefined;
				for (let i = 1; i < args.length; i++) {
					const a = args[i];
					if (a === '--runtime' || a.startsWith('--runtime=')) {
						const v = a === '--runtime' ? args[++i] : a.slice('--runtime='.length);
						if (v !== 'auto' && v !== 'workerd' && v !== 'container') {
							ctx.stderr.write('lifo cloud push: --runtime is auto, workerd or container\n');
							return 1;
						}
						runtime = v;
					} else if (a === '--sleep-after' || a.startsWith('--sleep-after=')) {
						const v = a === '--sleep-after' ? args[++i] : a.slice('--sleep-after='.length);
						sleepAfter = parseDuration(v);
						if (sleepAfter === undefined) {
							ctx.stderr.write(`lifo cloud push: --sleep-after takes a duration like 90s, 10m, 2h, or never\n`);
							return 1;
						}
					} else if (a === '--start' && args[i + 1] !== undefined) start = args[++i];
					else if (a.startsWith('--start=')) start = a.slice(8);
					else if (a === '--port' && args[i + 1]) port = Number(args[++i]);
					else if (a.startsWith('--port=')) port = Number(a.slice(7));
					else if (a === '--exclude' && args[i + 1]) exclude = args[++i].split(',').filter(Boolean);
					else if (a.startsWith('--exclude=')) exclude = a.slice(10).split(',').filter(Boolean);
					else {
						ctx.stderr.write(`lifo cloud push: unknown option ${a}\n`);
						return 1;
					}
				}
				if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
					ctx.stderr.write('lifo cloud push: --port must be 1-65535\n');
					return 1;
				}
				if (start === undefined) {
					const pkg = `${ctx.cwd}/package.json`;
					try {
						if (ctx.vfs.exists(pkg) && JSON.parse(ctx.vfs.readFileString(pkg))?.scripts?.start) start = 'npm start';
					} catch {
						/* not JSON */
					}
				}
				ctx.stdout.write(`Snapshotting this box...\n`);
				const snapshot = await exportVfsSnapshot(ctx.vfs, {
					exclude: [...CLOUD_ALWAYS_EXCLUDE, ...exclude],
					metadata: { cwd: ctx.cwd, env: cloudSafeEnv(ctx.env) },
				});
				ctx.stdout.write(`Uploading ${fmtBytes(snapshot.length)} to ${cloud.url}...\n`);
				const { box, boot } = await cloud.push(name, snapshot, { start, port, cwd: ctx.cwd, ...(sleepAfter !== undefined ? { sleepAfter } : {}), ...(runtime ? { runtime } : {}) });
				ctx.stdout.write(`\n  \x1b[32m●\x1b[0m ${box.name} is running in Lifo Cloud (booted in ${boot.bootMs} ms)\n`);
				if (box.runtime) ctx.stdout.write(`    runs:  ${box.runtime === 'container' ? 'in a container' : 'as a Lifo box (workerd)'}${box.runtimeReason ? ` \x1b[2m(${box.runtimeReason})\x1b[0m` : ''}\n`);
				if (start) ctx.stdout.write(`    start: ${start}\n`);
				if (box.sleepAfter !== undefined) ctx.stdout.write(`    sleeps after ${fmtDuration(box.sleepAfter)} idle\n`);
				if (box.url) ctx.stdout.write(`    url:   ${box.url}${boot.listening ? '' : '  (nothing is listening yet: lifo cloud logs ' + box.name + ')'}\n`);
				else if (port) ctx.stdout.write(`    url:   not ready yet; lifo cloud status ${box.name}\n`);
				ctx.stdout.write('\n');
				return 0;
			}
			case 'ls':
			case 'list': {
				const boxes = await cloud.list();
				if (!boxes.length) {
					ctx.stdout.write('No cloud boxes yet. Push this one: lifo cloud push <name> --port <n>\n');
					return 0;
				}
				for (const b of boxes) {
					const state = b.awake === undefined ? '' : `${b.awake ? '\x1b[32m●\x1b[0m awake ' : '○ asleep'}  `;
					const sleep = (b.sleepAfter === undefined ? '' : `  sleeps after ${fmtDuration(b.sleepAfter)}`) + (b.runtime === 'container' ? '  container' : '');
					ctx.stdout.write(`${state}${b.name.padEnd(24)} ${(b.url ?? '-').padEnd(44)} saved ${ago(b.savedAt).padEnd(9)} ${fmtBytes(b.snapshotBytes)}${sleep}\n`);
				}
				return 0;
			}
			case 'status': {
				if (!needName()) return 1;
				const { box, status } = await cloud.get(name);
				ctx.stdout.write(`${box.name}: ${status.awake ? (status.listening || !box.port ? 'awake' : 'awake, nothing listening') : 'asleep (wakes on the next request)'}\n`);
				if (box.url) ctx.stdout.write(`  url:   ${box.url}\n`);
				if (box.start) ctx.stdout.write(`  start: ${box.start}\n`);
				ctx.stdout.write(`  saved: ${ago(box.savedAt)} (${fmtBytes(box.snapshotBytes)})\n`);
				if (box.since) ctx.stdout.write(`  awake: since ${ago(new Date(box.since).toISOString())}\n`);
				if (box.sleepAfter !== undefined) ctx.stdout.write(`  sleep: after ${fmtDuration(box.sleepAfter)} idle\n`);
				if (box.runtime) ctx.stdout.write(`  runs:  ${box.runtime === 'container' ? 'in a container' : 'as a Lifo box (workerd)'}${box.runtimeReason ? ` (${box.runtimeReason})` : ''}\n`);
				return 0;
			}
			case 'stats': {
				if (!needName()) return 1;
				let range = '1h';
				for (let i = 1; i < args.length; i++) {
					if (args[i] === '--range' && args[i + 1]) range = args[++i];
					else if (args[i].startsWith('--range=')) range = args[i].slice(8);
				}
				if (!['1h', '6h', '24h', '7d', '30d'].includes(range)) {
					ctx.stderr.write('lifo cloud stats: --range is 1h, 6h, 24h, 7d or 30d\n');
					return 1;
				}
				const m = await cloud.metrics(name, range as '1h');
				const sum = (k: 'cpuMs' | 'requests' | 'errors' | 'bytesOut' | 'bytesIn') => m.points.reduce((a, p) => a + p[k], 0);
				const peakMem = Math.max(0, ...m.points.map((p) => p.memMB));
				const u = m.uptime;
				const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;
				ctx.stdout.write(`${name}  ${u.awake ? `\x1b[32m● awake\x1b[0m since ${ago(new Date(u.since!).toISOString())}` : `○ asleep${u.lastSleep ? ` since ${ago(new Date(u.lastSleep).toISOString())}` : ''}`}  ${dim(`last ${m.range}, ${m.step / 60} min per cell`)}\n\n`);
				ctx.stdout.write(`  requests  ${sparkline(m.points.map((p) => p.requests))}  ${fmtCount(sum('requests'))}${sum('errors') ? ` (${sum('errors')} errors)` : ''}\n`);
				ctx.stdout.write(`  cpu       ${sparkline(m.points.map((p) => p.cpuMs))}  ${(sum('cpuMs') / 1000).toFixed(1)} s\n`);
				ctx.stdout.write(`  awake     ${sparkline(m.points.map((p) => p.awake))}  ${fmtDuration(u.awakeSeconds)}\n`);
				ctx.stdout.write(`  memory    ${sparkline(m.points.map((p) => p.memMB))}  peak ${peakMem.toFixed(1)} MB${m.memEstimated ? ' (estimated)' : ''}\n`);
				ctx.stdout.write(`  traffic   ${fmtBytes(sum('bytesOut'))} out, ${fmtBytes(sum('bytesIn'))} in\n`);
				ctx.stdout.write(`  storage   ${fmtBytes(m.storageBytes)}\n`);
				ctx.stdout.write(`  boots     ${u.bootCount}${u.lastWake ? `, last ${ago(new Date(u.lastWake).toISOString())}` : ''}\n`);
				ctx.stdout.write(`  sleeps    after ${fmtDuration(m.settings.sleepAfter)} idle  ${dim(`(lifo cloud config ${name} --sleep-after 30m)`)}\n`);
				return 0;
			}
			case 'config': {
				if (!needName()) return 1;
				let sleepAfter: number | null | undefined;
				let given = false;
				let runtime: 'workerd' | 'container' | undefined;
				for (let i = 1; i < args.length; i++) {
					const a = args[i];
					if (a === '--sleep-after' || a.startsWith('--sleep-after=')) {
						given = true;
						sleepAfter = parseDuration(a === '--sleep-after' ? args[++i] : a.slice('--sleep-after='.length));
					} else if (a === '--runtime' || a.startsWith('--runtime=')) {
						const v = a === '--runtime' ? args[++i] : a.slice('--runtime='.length);
						if (v !== 'workerd' && v !== 'container') {
							ctx.stderr.write('lifo cloud config: --runtime is workerd or container\n');
							return 1;
						}
						runtime = v;
					} else {
						ctx.stderr.write(`lifo cloud config: unknown option ${a}\n`);
						return 1;
					}
				}
				if (runtime) {
					ctx.stdout.write(`Moving ${name} to ${runtime === 'container' ? 'a container' : 'a Lifo box (workerd)'} (its files move with it)...\n`);
					const { box } = await cloud.update(name, { runtime });
					ctx.stdout.write(`${name} now runs ${box.runtime === 'container' ? 'in a container' : 'as a Lifo box (workerd)'}.\n`);
					if (!given) return 0;
				}
				if (!given) {
					const { box } = await cloud.get(name);
					ctx.stdout.write(`${name}: sleeps after ${fmtDuration(box.sleepAfter ?? 300)} idle${box.runtime ? `, runs ${box.runtime === 'container' ? 'in a container' : 'as a Lifo box (workerd)'}` : ''}\n`);
					return 0;
				}
				if (sleepAfter === undefined) {
					ctx.stderr.write('lifo cloud config: --sleep-after takes a duration like 90s, 10m, 2h, or never\n');
					return 1;
				}
				const { box } = await cloud.update(name, { sleepAfter });
				ctx.stdout.write(`${name} now sleeps after ${fmtDuration(box.sleepAfter)} idle.\n`);
				return 0;
			}
			case 'usage': {
				let from: string | undefined;
				let to: string | undefined;
				for (let i = 0; i < args.length; i++) {
					if (args[i] === '--from' && args[i + 1]) from = args[++i];
					else if (args[i] === '--to' && args[i + 1]) to = args[++i];
				}
				const u = await cloud.usage({ from, to });
				const day = (iso: string) => iso.slice(0, 10);
				ctx.stdout.write(`Usage ${day(u.from)} to ${day(u.to)}\n\n`);
				const row = (label: string, t: typeof u.totals) =>
					`  ${label.padEnd(24)} ${fmtDuration(t.awakeSeconds).padStart(7)} awake  ${(t.cpuMs / 1000).toFixed(1).padStart(8)} s CPU  ${fmtCount(t.requests).padStart(7)} req  ${fmtBytes(t.bytesOut).padStart(9)} out  ${t.storageGBHours.toFixed(4).padStart(9)} GB-h\n`;
				for (const b of u.boxes) ctx.stdout.write(row(b.name, b));
				if (u.boxes.length > 1 || !u.boxes.length) ctx.stdout.write(row('total', u.totals));
				return 0;
			}
			case 'exec': {
				if (!needName()) return 1;
				const cmd = args.slice(1).join(' ').replace(/^--\s*/, '');
				if (!cmd) {
					ctx.stderr.write('lifo cloud exec: give a command, e.g. lifo cloud exec my-app ls\n');
					return 1;
				}
				const res = await cloud.exec(name, cmd);
				ctx.stdout.write(res.stdout);
				ctx.stderr.write(res.stderr);
				return res.exitCode;
			}
			case 'shell':
			case 'ssh': {
				if (!needName()) return 1;
				return await cloudShell(ctx, cloud, name);
			}
			case 'logs': {
				if (!needName()) return 1;
				ctx.stdout.write(await cloud.logs(name));
				return 0;
			}
			case 'save': {
				if (!needName()) return 1;
				const res = await cloud.save(name);
				ctx.stdout.write(res.saved ? `Checkpointed ${name} (${fmtBytes(res.snapshotBytes)}). Its files are always saved as they change.\n` : `${name}'s files are saved as they change; no checkpoint was needed.\n`);
				return 0;
			}
			case 'pull': {
				if (!needName()) return 1;
				const bytes = await cloud.pull(name);
				const meta = await importVfsSnapshot(ctx.vfs, bytes);
				ctx.stdout.write(`Pulled ${name} (${fmtBytes(bytes.length)}) into this box${meta?.cwd ? `; its working directory was ${meta.cwd}` : ''}.\n`);
				if (args.includes('--with-data')) {
					// The database lives outside the box in the cloud: its app data comes along as SQL.
					const sql = await cloud.dataSql(name);
					if (sql === null) ctx.stdout.write(`${name} has no database yet.\n`);
					else {
						const dir = meta?.cwd && ctx.vfs.exists(meta.cwd) ? meta.cwd : ctx.cwd;
						const file = `${dir === '/' ? '' : dir}/${name}.data.sql`;
						ctx.vfs.writeFile(file, sql);
						ctx.stdout.write(`Its database's data is in ${file}: append it to supabase/seed.sql to load it into tinbase here.\n`);
					}
				}
				return 0;
			}
			case 'restart': {
				if (!needName()) return 1;
				await cloud.restart(name);
				ctx.stdout.write(`Restarted ${name}: new processes, same files.\n`);
				return 0;
			}
			case 'rm':
			case 'delete': {
				if (!needName()) return 1;
				await cloud.remove(name);
				ctx.stdout.write(`Deleted ${name}.\n`);
				return 0;
			}
			default:
				ctx.stderr.write(`lifo cloud: unknown command ${sub}\n${CLOUD_USAGE}`);
				return 1;
		}
	} catch (e) {
		ctx.stderr.write(`lifo cloud ${sub}: ${(e as Error).message}\n`);
		return 1;
	}
}
