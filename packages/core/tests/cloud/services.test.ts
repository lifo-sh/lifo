import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { LifoServices, sha256Hex } from '../../src/cloud/services-client.js';
import { createRemoteToolCommand, registerOrLocal, setLocalTool } from '../../src/commands/system/remote-tool.js';
import type { CommandContext } from '../../src/commands/types.js';

/**
 * A stand-in for Lifo services: keeps blobs, and its "ffmpeg" writes `<last arg>` holding the
 * upper-cased text of the `-i` input. Records what it was sent.
 */
function fakeService() {
	const blobs = new Map<string, Uint8Array>();
	const state = { blobs, uploads: [] as string[], jobs: [] as { tool: string; args: string[]; files: { path: string; sha256: string }[]; dirs: string[]; stdin?: { sha256: string } }[], consent: [] as string[], tokens: [] as string[] };
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const handler = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		if (url.host === 'acct.test') return json({ tunnelUrl: 'ws://x', servicesUrl: 'http://svc.test' });
		if (url.host !== 'svc.test') throw new Error(`unexpected fetch ${url}`);
		const auth = new Headers(init.headers).get('authorization') ?? '';
		state.tokens.push(auth);
		if (auth !== 'Bearer lifo_test') return json({ error: 'Log in first: lifo login' }, 401);
		const method = init.method ?? 'GET';
		const p = url.pathname;
		if (p === '/v1/tools') return json({ tools: [{ name: 'ffmpeg', version: '7', description: 'd', limits: { timeoutS: 120, cpus: 1, memoryMB: 1024, maxInputMB: 200, maxOutputMB: 200 } }, { name: 'ffprobe', version: '7', description: 'd', limits: { timeoutS: 120, cpus: 1, memoryMB: 1024, maxInputMB: 200, maxOutputMB: 200 } }], consent: { tools: state.consent } });
		if (p === '/v1/consent' && method === 'GET') return json({ tools: state.consent });
		if (p === '/v1/consent' && method === 'PUT') {
			state.consent = JSON.parse(String(init.body)).tools;
			return json({ tools: state.consent });
		}
		if (p === '/v1/blobs/check') return json({ missing: (JSON.parse(String(init.body)).hashes as string[]).filter((h) => !blobs.has(h)) });
		const blob = /^\/v1\/blobs\/([0-9a-f]{64})$/.exec(p);
		if (blob && method === 'PUT') {
			blobs.set(blob[1], new Uint8Array(init.body as Uint8Array));
			state.uploads.push(blob[1]);
			return json({ sha256: blob[1] });
		}
		if (blob) return blobs.has(blob[1]) ? new Response(blobs.get(blob[1]) as unknown as BodyInit) : json({ error: 'No such file' }, 404);
		if (p === '/v1/jobs') {
			const job = JSON.parse(String(init.body));
			state.jobs.push(job);
			const b64 = (s: string) => btoa(s);
			const lines: unknown[] = [{ t: 'start', id: 'j1', tool: job.tool, version: '7' }, { t: 'e', b: b64(`fake ${job.tool}\n`) }];
			const i = job.args.indexOf('-i');
			const inPath = i >= 0 ? job.args[i + 1] : null;
			const src = inPath === 'pipe:0' ? job.stdin && blobs.get(job.stdin.sha256) : job.files.find((f: { path: string }) => f.path === inPath) && blobs.get(job.files.find((f: { path: string }) => f.path === inPath).sha256);
			if (!src) lines.push({ t: 'e', b: b64(`${inPath}: No such file or directory\n`) }, { t: 'exit', code: 254, usage: { cpuMs: 1, wallMs: 2, bytesIn: 0, bytesOut: 0 } });
			else if (job.tool === 'ffprobe') lines.push({ t: 'o', b: b64(`{"size":${src.length}}\n`) }, { t: 'exit', code: 0, usage: { cpuMs: 1, wallMs: 2, bytesIn: src.length, bytesOut: 0 } });
			else {
				const out = new TextEncoder().encode(new TextDecoder().decode(src).toUpperCase());
				const sha = await sha256Hex(out);
				blobs.set(sha, out);
				lines.push({ t: 'file', path: job.args.at(-1), sha256: sha, size: out.length }, { t: 'exit', code: 0, usage: { cpuMs: 5, wallMs: 9, bytesIn: src.length, bytesOut: out.length } });
			}
			// Split mid-line across chunks, as a network would.
			const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
			const cut = Math.floor(text.length / 2);
			const enc = new TextEncoder();
			return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text.slice(0, cut))); c.enqueue(enc.encode(text.slice(cut))); c.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
		}
		return json({ error: 'Not found.' }, 404);
	};
	return { state, handler };
}

const ENV = { LIFO_AUTH_TOKEN: 'lifo_test', LIFO_BASE_URL: 'http://acct.test' };
let svc: ReturnType<typeof fakeService>;

beforeEach(() => {
	svc = fakeService();
	vi.stubGlobal('fetch', vi.fn(svc.handler));
});
afterEach(() => vi.unstubAllGlobals());

describe('LifoServices', () => {
	it('uploads only what the service is missing, streams events and downloads results', async () => {
		const s = await LifoServices.connect({ token: 'lifo_test', baseUrl: 'http://acct.test' });
		expect(s.url).toBe('http://svc.test');
		const bytes = new TextEncoder().encode('hello');
		let stderr = '';
		const job = { tool: 'ffmpeg', args: ['-i', 'a.txt', 'b.txt'], files: [{ path: 'a.txt', bytes }], onStderr: (b: Uint8Array) => (stderr += new TextDecoder().decode(b)) };
		const first = await s.run(job);
		expect(first.exitCode).toBe(0);
		expect(first.uploaded).toEqual({ files: 1, bytes: 5 });
		expect(stderr).toBe('fake ffmpeg\n');
		expect(first.files).toHaveLength(1);
		expect(new TextDecoder().decode(await s.download(first.files[0].sha256))).toBe('HELLO');
		const second = await s.run(job);
		expect(second.uploaded).toEqual({ files: 0, bytes: 0 });
		expect(svc.state.uploads).toHaveLength(1);
	});

	it('says so when the account server has no services', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tunnelUrl: 'ws://x', servicesUrl: null }))));
		await expect(LifoServices.connect({ token: 't', baseUrl: 'http://acct.test' })).rejects.toThrow(/aren't available/);
	});
});

describe('ffmpeg in a box', () => {
	it('sends nothing until the tool is allowed, then runs remotely and writes the result back', async () => {
		const box = await Sandbox.create({ env: ENV });
		await box.fs.writeFile('/home/user/in.txt', 'tone');
		const refused = await box.commands.run('ffmpeg -i in.txt out.txt');
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr).toContain('would upload 1 file (4 B)');
		expect(refused.stderr).toContain('lifo services allow ffmpeg');
		expect(svc.state.uploads).toHaveLength(0);
		expect(svc.state.jobs).toHaveLength(0);

		expect((await box.commands.run('lifo services allow ffmpeg')).exitCode).toBe(0);
		const ok = await box.commands.run('ffmpeg -i in.txt out.txt');
		expect(ok.stderr).toBe('fake ffmpeg\n');
		expect(ok.exitCode).toBe(0);
		expect(await box.fs.readFile('/home/user/out.txt')).toBe('TONE');
		expect(svc.state.jobs[0]).toMatchObject({ tool: 'ffmpeg', args: ['-i', 'in.txt', 'out.txt'], files: [{ path: 'in.txt' }] });

		// ffprobe is a different tool: its own consent. LIFO_SERVICES_ALLOW answers for one run.
		expect((await box.commands.run('ffprobe -i in.txt')).exitCode).toBe(1);
		const probe = await box.commands.run('LIFO_SERVICES_ALLOW=ffprobe ffprobe -i in.txt');
		expect(probe.stdout).toBe('{"size":4}\n');
		expect(svc.state.uploads).toHaveLength(1); // the same file: not uploaded again
		box.destroy();
	});

	it('maps files outside the working directory in and out, and creates output folders', async () => {
		const box = await Sandbox.create({ env: { ...ENV, LIFO_SERVICES_ALLOW: 'all' } });
		await box.fs.mkdir('/data', { recursive: true });
		await box.fs.mkdir('/home/user/out', { recursive: true });
		await box.fs.mkdir('/tmp/res', { recursive: true });
		await box.fs.writeFile('/data/a.txt', 'abs');
		const r = await box.commands.run('ffmpeg -b:a 64k -i /data/a.txt /tmp/res/b.txt && ffmpeg -i ../../data/a.txt out/c.txt');
		expect(r.exitCode).toBe(0);
		expect(await box.fs.readFile('/tmp/res/b.txt')).toBe('ABS');
		expect(await box.fs.readFile('/home/user/out/c.txt')).toBe('ABS');
		const [a, b] = svc.state.jobs;
		expect(a.args).toEqual(['-b:a', '64k', '-i', '_lifo/0/a.txt', '_lifo/1/b.txt']);
		expect(b.args).toEqual(['-i', '_lifo/0/a.txt', 'out/c.txt']);
		expect(b.dirs).toContain('out');
		for (const j of svc.state.jobs) for (const arg of j.args) expect(arg.startsWith('/') || arg.includes('..')).toBe(false);
		box.destroy();
	});

	it('LIFO_EXEC picks where it runs; a local tool takes small jobs in auto mode', async () => {
		const box = await Sandbox.create({ env: { ...ENV, LIFO_SERVICES_ALLOW: 'all' } });
		await box.fs.writeFile('/home/user/in.txt', 'x'.repeat(100));
		const none = await box.commands.run('LIFO_EXEC=local ffmpeg -i in.txt o.txt');
		expect(none.exitCode).toBe(127);
		expect(none.stderr).toContain('no ffmpeg inside this box');
		expect((await box.commands.run('LIFO_EXEC=sideways ffmpeg -i in.txt o.txt')).exitCode).toBe(2);

		setLocalTool(box.kernel.vfs, 'ffmpeg', { maxBytes: 50, command: async (ctx) => (ctx.stdout.write('local ffmpeg\n'), 0) });
		expect((await box.commands.run('LIFO_EXEC=local ffmpeg -i in.txt o.txt')).stdout).toBe('local ffmpeg\n');
		expect((await box.commands.run('ffmpeg -i in.txt o.txt')).stderr).toBe('fake ffmpeg\n'); // 100 B > 50 B: the service
		await box.fs.writeFile('/home/user/small.txt', 'tiny');
		expect((await box.commands.run('ffmpeg -i small.txt o.txt')).stdout).toBe('local ffmpeg\n');
		expect((await box.commands.run('LIFO_EXEC=remote ffmpeg -i small.txt o.txt')).stderr).toBe('fake ffmpeg\n');
		// o.txt exists by now; as an output it isn't uploaded again.
		expect(svc.state.jobs.at(-1)!.files.map((f) => f.path)).toEqual(['small.txt']);
		box.destroy();
	});

	it('an installed package of the same name becomes the local half, not a replacement', async () => {
		const box = await Sandbox.create({ env: { ...ENV, LIFO_SERVICES_ALLOW: 'all' } });
		const registered: string[] = [];
		const registry = { register: (name: string) => void registered.push(name) };
		registerOrLocal(registry, box.kernel.vfs, 'ffmpeg', async (ctx) => (ctx.stdout.write('wasm ffmpeg\n'), 0));
		registerOrLocal(registry, box.kernel.vfs, 'cowsay', async () => 0);
		expect(registered).toEqual(['cowsay']);
		await box.fs.writeFile('/home/user/in.txt', 'small');
		expect((await box.commands.run('ffmpeg -i in.txt o.txt')).stdout).toBe('wasm ffmpeg\n');
		expect((await box.commands.run('LIFO_EXEC=remote ffmpeg -i in.txt o.txt')).stderr).toBe('fake ffmpeg\n');
		box.destroy();
	});

	it('needs a login, and passes a tool failure through', async () => {
		const out = await Sandbox.create();
		await out.fs.writeFile('/home/user/in.txt', 'x');
		const r = await out.commands.run('ffmpeg -i in.txt o.txt');
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain('lifo login');
		out.destroy();

		const box = await Sandbox.create({ env: { ...ENV, LIFO_SERVICES_ALLOW: 'all' } });
		const fail = await box.commands.run('ffmpeg -i nope.txt o.txt');
		expect(fail.exitCode).toBe(254);
		expect(fail.stderr).toContain('nope.txt: No such file');
		box.destroy();
	});

	it('lifo services lists tools and manages consent for the box and the account', async () => {
		const box = await Sandbox.create({ env: ENV });
		expect((await box.commands.run('lifo services')).stdout).toMatch(/ffmpeg\s+7[\s\S]*asks before uploading/);
		await box.commands.run('lifo services allow ffmpeg --always');
		expect(svc.state.consent).toEqual(['ffmpeg']);
		expect((await box.commands.run('lifo services')).stdout).toContain('always allowed (account)');
		// A new box on the same account doesn't ask.
		const other = await Sandbox.create({ env: ENV });
		await other.fs.writeFile('/home/user/in.txt', 'again');
		expect((await other.commands.run('ffmpeg -i in.txt o.txt')).exitCode).toBe(0);
		await box.commands.run('lifo services deny ffmpeg');
		expect(svc.state.consent).toEqual([]);
		expect((await box.commands.run('lifo services allow nope')).exitCode).toBe(1);
		box.destroy();
		other.destroy();
	});
});

describe('the consent prompt', () => {
	async function prompt(answer: string) {
		const box = await Sandbox.create({ env: ENV });
		await box.fs.writeFile('/home/user/in.txt', 'tone');
		let stderr = '';
		let read = false;
		const ctx: CommandContext = {
			args: ['-i', 'in.txt', 'out.txt'],
			env: { ...ENV, HOME: '/home/user' },
			cwd: '/home/user',
			vfs: box.kernel.vfs,
			stdout: { write: () => {} },
			stderr: { write: (t) => void (stderr += t), isTTY: true },
			signal: new AbortController().signal,
			stdin: { read: async () => (read ? null : ((read = true), answer + '\n')), readAll: async () => answer },
			setRawMode: () => {},
		};
		const code = await createRemoteToolCommand('ffmpeg')(ctx);
		return { box, code, stderr };
	}

	it('asks once per tool: "once" runs this time only', async () => {
		const { box, code, stderr } = await prompt('o');
		expect(stderr).toContain('ffmpeg will run on Lifo Cloud; 1 file (4 B) from this box is uploaded: in.txt');
		expect(stderr).toContain('[o]nce / [a]lways for your account / [n]o');
		expect(code).toBe(0);
		expect(svc.state.consent).toEqual([]);
		expect(box.kernel.vfs.exists('/home/user/.lifo/services.json')).toBe(false);
		box.destroy();
	});

	it('"always" is saved to the account; "no" sends nothing', async () => {
		const yes = await prompt('a');
		expect(yes.code).toBe(0);
		expect(svc.state.consent).toEqual(['ffmpeg']);
		yes.box.destroy();

		svc.state.consent = [];
		const uploads = svc.state.uploads.length;
		const no = await prompt('n');
		expect(no.code).toBe(1);
		expect(no.stderr).toContain('nothing was sent');
		expect(svc.state.uploads).toHaveLength(uploads);
		no.box.destroy();
	});
});
