/**
 * Tools that run on Lifo's servers: `ffmpeg`, `ffprobe`, and `lifo services`.
 *
 * A box in a tab or an isolate can't carry a native ffmpeg, a GPU or a browser engine. These
 * commands keep the name people and agents already type and run the tool on Lifo services
 * (cloud/services-client.ts): the files the command reads are uploaded, the tool runs in an
 * isolated container, and what it writes comes back into the box.
 *
 * Where a command runs is a policy, `LIFO_EXEC`:
 *   auto    (default) a local implementation if one is registered and the input is small, else
 *           the service
 *   local   only ever in the box
 *   remote  always the service
 *
 * Files never leave the box silently. The first time a tool would upload something it asks
 * (once / always for this account / no). `lifo services allow <tool>` answers ahead of time, for
 * scripts and agents.
 */

import type { Command, CommandContext } from '../types.js';
import type { VFS } from '../../kernel/vfs/index.js';
import { basename, dirname, resolve as resolvePath } from '../../utils/path.js';
import { fetchCliConfig } from '../../cloud/auth.js';
import { LifoServices, ServiceError, type ServiceResult } from '../../cloud/services-client.js';
import { readLine, resolve as resolveLogin } from './lifo-cloud.js';

// ─── Local implementations (the policy hook) ───

export interface LocalTool {
	command: Command;
	/** In `auto` mode, inputs larger than this go to the service instead. Default 25 MB. */
	maxBytes?: number;
}

const DEFAULT_LOCAL_MAX = 25 * 1024 * 1024;
const localTools = new WeakMap<VFS, Map<string, LocalTool>>();

/**
 * Give a box an in-box implementation of a tool that otherwise runs on Lifo services (for
 * example ffmpeg.wasm for `ffmpeg`). With `LIFO_EXEC=auto` the box uses it for small inputs and
 * the service for the rest.
 */
export function setLocalTool(vfs: VFS, name: string, tool: LocalTool | undefined): void {
	let map = localTools.get(vfs);
	if (!map) localTools.set(vfs, (map = new Map()));
	if (tool) map.set(name, tool);
	else map.delete(name);
}

/** The tools that run on Lifo services. An installed package of the same name becomes its local half. */
export const REMOTE_TOOLS = ['ffmpeg', 'ffprobe'];

/**
 * Register a command a package provides. If Lifo services also run that tool (`lifo install
 * ffmpeg` brings ffmpeg.wasm), the package becomes the in-box implementation behind the same
 * command, so `LIFO_EXEC` still decides where a run happens.
 */
export function registerOrLocal(registry: { register(name: string, cmd: Command): void }, vfs: VFS, name: string, command: Command): void {
	if (REMOTE_TOOLS.includes(name)) setLocalTool(vfs, name, { command });
	else registry.register(name, command);
}

// ─── Consent ───

interface ConsentFile {
	/** Tools this box may send files to without asking. */
	allow: string[];
}

const consentPath = (ctx: CommandContext) => `${ctx.env.HOME || '/home/user'}/.lifo/services.json`;

function readConsent(ctx: CommandContext): ConsentFile {
	try {
		const c = JSON.parse(ctx.vfs.readFileString(consentPath(ctx))) as ConsentFile;
		return { allow: Array.isArray(c.allow) ? c.allow : [] };
	} catch {
		return { allow: [] };
	}
}

function writeConsent(ctx: CommandContext, c: ConsentFile): void {
	const file = consentPath(ctx);
	if (!ctx.vfs.exists(dirname(file))) ctx.vfs.mkdir(dirname(file), { recursive: true });
	ctx.vfs.writeFile(file, JSON.stringify(c, null, 2) + '\n');
}

function envAllows(ctx: CommandContext, tool: string): boolean {
	const v = (ctx.env.LIFO_SERVICES_ALLOW || '').split(',').map((s) => s.trim());
	return v.includes('all') || v.includes(tool);
}

// The account's "always allow" list, fetched once per box.
const accountConsent = new WeakMap<VFS, Set<string>>();

// ─── Connecting ───

/**
 * Lifo services for this box, with its login: a client, or a sentence saying why not (not logged
 * in, or the account server has no services). Used by the remote tools and by other packages'
 * commands (lifo-pkg-agent's `browser`).
 */
export async function connectServices(ctx: CommandContext, what: string): Promise<LifoServices | string> {
	return connect(ctx, what);
}

async function connect(ctx: CommandContext, what: string): Promise<LifoServices | string> {
	const login = await resolveLogin(ctx);
	if (!login.token) return `${what} runs on Lifo Cloud here, which needs a login. Run: lifo login`;
	const url = ctx.env.LIFO_SERVICES_URL || (await fetchCliConfig(login.baseUrl).catch(() => null))?.servicesUrl;
	if (!url) return `${what} runs on Lifo services, which aren't available on ${login.baseUrl} yet.`;
	return new LifoServices({ token: login.token, url });
}

// ─── Planning a job from a command line ───

// ffmpeg flags that take no value: a file right after one is an output, like any positional.
const FFMPEG_FLAGS = new Set(['-y', '-n', '-an', '-vn', '-sn', '-dn', '-shortest', '-hide_banner', '-nostdin', '-nostats', '-stats', '-copyts', '-re', '-accurate_seek', '-ignore_unknown', '-copy_unknown', '-benchmark', '-xerror']);

/**
 * Is argument i a file the tool will write rather than read? An output that already exists in
 * the box (a second run of the same command) would otherwise be uploaded just to be overwritten.
 * ffmpeg's outputs are its positional arguments; when unsure the file is sent.
 */
const WRITES: Record<string, (args: string[], i: number) => boolean> = {
	ffmpeg: (args, i) => i > 0 && (!args[i - 1].startsWith('-') || FFMPEG_FLAGS.has(args[i - 1])),
};

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

interface Plan {
	args: string[];
	files: { path: string; bytes: Uint8Array; box: string }[];
	dirs: string[];
	/** Job path → box path, for files that live outside the working directory. */
	outside: Map<string, string>;
	usesStdin: boolean;
	bytes: number;
}

/**
 * Turn the box's command line into a job. Every argument that names a file in the box becomes an
 * input. Paths inside the working directory keep their names; paths outside it (absolute, `../`)
 * are given a place under `_lifo/` in the job and mapped back afterwards. Paths written inside
 * another argument (a filter string) aren't seen.
 */
function plan(ctx: CommandContext, tool: string): Plan {
	const cwd = ctx.cwd.replace(/\/+$/, '') || '/';
	const prefix = cwd === '/' ? '/' : `${cwd}/`;
	const out: Plan = { args: [], files: [], dirs: [], outside: new Map(), usesStdin: false, bytes: 0 };
	const dirs = new Set<string>();
	const seen = new Set<string>();
	let n = 0;
	for (let i = 0; i < ctx.args.length; i++) {
		const arg = ctx.args[i];
		if (arg === '-' || /^pipe:0?$/.test(arg)) out.usesStdin = true;
		const looksLikePath = !arg.startsWith('-') && !/^[a-z][a-z0-9+.-]*:/i.test(arg) && arg !== '';
		if (!looksLikePath) {
			out.args.push(arg);
			continue;
		}
		const abs = resolvePath(cwd, arg);
		const inside = abs.startsWith(prefix) && abs !== cwd;
		const exists = ctx.vfs.exists(abs);
		const isFile = exists && ctx.vfs.stat(abs).type === 'file';
		// A word that isn't a path (64k, libx264, 00:00:05) passes through untouched.
		const pathy = isFile || arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../') || arg.includes('/');
		if (!pathy) {
			out.args.push(arg);
			continue;
		}
		let jobPath: string;
		if (inside) jobPath = abs.slice(prefix.length);
		else {
			// Outside the working directory: only real files, or outputs into a folder that exists.
			if (!isFile && !(ctx.vfs.exists(dirname(abs)) && !exists)) {
				out.args.push(arg);
				continue;
			}
			jobPath = [...out.outside].find(([, box]) => box === abs)?.[0] ?? `_lifo/${n++}/${basename(abs)}`;
			out.outside.set(jobPath, abs);
		}
		out.args.push(jobPath);
		if (isFile && !seen.has(jobPath) && !WRITES[tool]?.(ctx.args, i)) {
			seen.add(jobPath);
			const bytes = ctx.vfs.readFile(abs);
			out.files.push({ path: jobPath, bytes, box: abs });
			out.bytes += bytes.length;
		}
		if (jobPath.includes('/') && (inside ? ctx.vfs.exists(dirname(abs)) : true)) dirs.add(dirname(jobPath));
	}
	out.dirs = [...dirs].filter((d) => d && d !== '.');
	return out;
}

// ─── The command ───

export function createRemoteToolCommand(tool: string): Command {
	return async (ctx) => {
		const mode = (ctx.env.LIFO_EXEC || 'auto').toLowerCase();
		if (!['auto', 'local', 'remote'].includes(mode)) {
			ctx.stderr.write(`${tool}: LIFO_EXEC must be auto, local or remote (got "${ctx.env.LIFO_EXEC}")\n`);
			return 2;
		}
		const job = plan(ctx, tool);
		const local = localTools.get(ctx.vfs)?.get(tool);
		if (mode === 'local' || (mode === 'auto' && local && job.bytes <= (local.maxBytes ?? DEFAULT_LOCAL_MAX))) {
			if (local) return local.command(ctx);
			ctx.stderr.write(`${tool}: there is no ${tool} inside this box, and LIFO_EXEC=local keeps it from running on Lifo Cloud.\n`);
			return 127;
		}

		const services = await connect(ctx, tool);
		if (typeof services === 'string') {
			ctx.stderr.write(`${tool}: ${services}\n`);
			return 1;
		}

		let stdin: Uint8Array | undefined;
		if (job.usesStdin && ctx.stdin) stdin = new TextEncoder().encode(await ctx.stdin.readAll());
		const uploadBytes = job.bytes + (stdin?.length ?? 0);
		const uploadCount = job.files.length + (stdin?.length ? 1 : 0);

		// Nothing leaves the box without a yes.
		if (uploadCount > 0 && !(await allowed(ctx, tool, services, job, uploadCount, uploadBytes))) return 1;

		const abort = new AbortController();
		const onAbort = () => abort.abort();
		ctx.signal.addEventListener('abort', onAbort);
		const out = new TextDecoder();
		const err = new TextDecoder();
		let result: ServiceResult;
		try {
			result = await services.run({
				tool,
				args: job.args,
				files: job.files,
				dirs: job.dirs,
				stdin,
				signal: abort.signal,
				onStdout: (b) => ctx.stdout.write(out.decode(b, { stream: true })),
				onStderr: (b) => ctx.stderr.write(err.decode(b, { stream: true })),
			});
		} catch (e) {
			if (ctx.signal.aborted) return 130;
			ctx.stderr.write(`${tool}: ${e instanceof ServiceError && e.status === 401 ? 'your login has expired. Run: lifo login' : (e as Error).message}\n`);
			return 1;
		} finally {
			ctx.signal.removeEventListener('abort', onAbort);
		}

		// What the tool wrote comes back into the box, at the paths the command named.
		try {
			for (const f of result.files) {
				const target = job.outside.get(f.path) ?? resolvePath(ctx.cwd, f.path);
				if (f.path.startsWith('_lifo/') && !job.outside.has(f.path)) continue;
				if (!ctx.vfs.exists(dirname(target))) ctx.vfs.mkdir(dirname(target), { recursive: true });
				ctx.vfs.writeFile(target, await services.download(f.sha256));
			}
		} catch (e) {
			ctx.stderr.write(`${tool}: the job finished but a result couldn't be fetched: ${(e as Error).message}\n`);
			return 1;
		}

		if (result.reason) {
			const why = {
				timeout: 'it ran past the time limit for your plan',
				memory: 'it ran out of memory',
				'output-limit': 'its output went over the size limit for your plan',
				cancelled: 'it was cancelled',
			}[result.reason];
			ctx.stderr.write(`${tool}: stopped by Lifo Cloud: ${why}.\n`);
		}
		if (ctx.stderr.isTTY && ctx.env.LIFO_SERVICES_QUIET !== '1') {
			const up = result.uploaded.files ? `uploaded ${result.uploaded.files} file${result.uploaded.files === 1 ? '' : 's'} (${fmtBytes(result.uploaded.bytes)})` : uploadCount ? 'nothing to upload (already there)' : 'no files sent';
			ctx.stderr.write(`\x1b[2m☁ ${tool} ran on Lifo Cloud: ${up}, ${(result.usage.cpuMs / 1000).toFixed(2)} s CPU, ${result.files.length} file${result.files.length === 1 ? '' : 's'} back\x1b[0m\n`);
		}
		return result.exitCode;
	};
}

async function allowed(ctx: CommandContext, tool: string, services: LifoServices, job: Plan, count: number, bytes: number): Promise<boolean> {
	if (envAllows(ctx, tool) || readConsent(ctx).allow.includes(tool)) return true;
	let account = accountConsent.get(ctx.vfs);
	if (!account) {
		try {
			account = new Set(await services.consent());
			accountConsent.set(ctx.vfs, account);
		} catch (e) {
			ctx.stderr.write(`${tool}: ${(e as Error).message}\n`);
			return false;
		}
	}
	if (account.has(tool)) return true;

	const what = `${count} file${count === 1 ? '' : 's'} (${fmtBytes(bytes)})`;
	// A prompt needs a person: a terminal on stderr and a keyboard on stdin (not a pipe feeding the tool).
	const interactive = !!ctx.stderr.isTTY && !!ctx.stdin && !!ctx.setRawMode && !job.usesStdin;
	if (!interactive) {
		ctx.stderr.write(
			`${tool}: runs on Lifo Cloud, and would upload ${what} from this box. Nobody is here to ask, so nothing was sent.\n` +
				`  Allow it first:  lifo services allow ${tool}            (this box)\n` +
				`                   lifo services allow ${tool} --always   (your account)\n` +
				`  or set LIFO_SERVICES_ALLOW=${tool} for this run.\n`,
		);
		return false;
	}
	const names = job.files.slice(0, 5).map((f) => f.path.startsWith('_lifo/') ? f.box : f.path).join(', ') + (job.files.length > 5 ? ', ...' : '');
	ctx.stderr.write(`${tool} will run on Lifo Cloud; ${what} from this box ${count === 1 ? 'is' : 'are'} uploaded${names ? `: ${names}` : ''}.\n`);
	ctx.stderr.write('Allow? [o]nce / [a]lways for your account / [n]o: ');
	const answer = ((await readLine(ctx)) ?? '').trim().toLowerCase();
	ctx.stderr.write('\n');
	if (answer === 'a' || answer === 'always') {
		try {
			account.add(tool);
			await services.setConsent([...account]);
		} catch (e) {
			ctx.stderr.write(`${tool}: couldn't save that to your account (${(e as Error).message}); allowing it in this box instead.\n`);
			const c = readConsent(ctx);
			writeConsent(ctx, { allow: [...new Set([...c.allow, tool])] });
		}
		return true;
	}
	if (answer === 'o' || answer === 'once' || answer === 'y' || answer === 'yes') return true;
	ctx.stderr.write(`${tool}: nothing was sent.\n`);
	return false;
}

// ─── lifo services ───

const USAGE = `Usage: lifo services [command]

Some commands run on Lifo's servers instead of in the box (ffmpeg, ffprobe). Their input files
are uploaded for the run, and each tool asks before it does that the first time.

  lifo services                      the tools, their limits, and what you've allowed
  lifo services allow <tool>         let this box send files to a tool without asking
  lifo services allow <tool> --always   the same for your whole account, in every box
  lifo services deny <tool>          ask again (removes both)
  lifo services usage                this month's jobs, CPU time and transfer

LIFO_EXEC=auto|local|remote chooses where such a command runs (default auto).
`;

export async function lifoServicesCommand(ctx: CommandContext): Promise<number> {
	const [sub = 'ls', ...rest] = ctx.args.slice(1);
	if (sub === '--help' || sub === '-h' || sub === 'help') {
		ctx.stdout.write(USAGE);
		return 0;
	}
	const services = await connect(ctx, 'lifo services');
	if (typeof services === 'string') {
		ctx.stderr.write(`lifo services: ${services.replace(/^lifo services runs on Lifo Cloud here, which needs/, 'needs')}\n`);
		return 1;
	}
	try {
		if (sub === 'ls' || sub === 'list') {
			const { tools, consent } = await services.tools();
			const box = readConsent(ctx).allow;
			const local = localTools.get(ctx.vfs);
			for (const t of tools) {
				const state = consent.tools.includes(t.name) ? 'always allowed (account)' : box.includes(t.name) || envAllows(ctx, t.name) ? 'allowed in this box' : 'asks before uploading';
				ctx.stdout.write(`${t.name.padEnd(10)} ${t.version.padEnd(5)} ${t.description}\n`);
				ctx.stdout.write(`${' '.repeat(16)} ${state}${local?.has(t.name) ? '; small jobs run in the box' : ''}; up to ${t.limits.timeoutS} s, ${t.limits.cpus} CPU, ${t.limits.memoryMB} MB, ${t.limits.maxInputMB} MB in\n`);
			}
			return 0;
		}
		if (sub === 'allow' || sub === 'deny') {
			const always = rest.includes('--always');
			const names = rest.filter((a) => !a.startsWith('-'));
			if (!names.length) {
				ctx.stderr.write(`Usage: lifo services ${sub} <tool>${sub === 'allow' ? ' [--always]' : ''}\n`);
				return 2;
			}
			const known = (await services.tools()).tools.map((t) => t.name);
			const unknown = names.find((n) => !known.includes(n));
			if (unknown) {
				ctx.stderr.write(`lifo services: there is no tool called "${unknown}" (${known.join(', ')})\n`);
				return 1;
			}
			const box = new Set(readConsent(ctx).allow);
			const account = new Set(await services.consent());
			if (sub === 'allow') {
				if (always) {
					for (const n of names) account.add(n);
					await services.setConsent([...account]);
					ctx.stdout.write(`${names.join(', ')}: always allowed for your account. Undo with: lifo services deny ${names[0]}\n`);
				} else {
					for (const n of names) box.add(n);
					writeConsent(ctx, { allow: [...box] });
					ctx.stdout.write(`${names.join(', ')}: allowed in this box.\n`);
				}
			} else {
				for (const n of names) {
					box.delete(n);
					account.delete(n);
				}
				writeConsent(ctx, { allow: [...box] });
				await services.setConsent([...account]);
				ctx.stdout.write(`${names.join(', ')}: will ask before uploading again.\n`);
			}
			accountConsent.set(ctx.vfs, account);
			return 0;
		}
		if (sub === 'usage') {
			const u = await services.usage();
			ctx.stdout.write(`Since ${u.from.slice(0, 10)}: ${u.totals.jobs} job${u.totals.jobs === 1 ? '' : 's'}, ${(u.totals.cpuMs / 1000).toFixed(1)} s CPU, ${fmtBytes(u.totals.bytesIn)} in, ${fmtBytes(u.totals.bytesOut)} out (preview: not billed)\n`);
			for (const t of u.tools) ctx.stdout.write(`  ${t.tool.padEnd(10)} ${String(t.jobs).padStart(4)} jobs  ${(t.cpuMs / 1000).toFixed(1).padStart(7)} s CPU\n`);
			return 0;
		}
	} catch (e) {
		ctx.stderr.write(`lifo services: ${(e as Error).message}\n`);
		return 1;
	}
	ctx.stderr.write(`lifo services: unknown command '${sub}'\n\n${USAGE}`);
	return 2;
}
