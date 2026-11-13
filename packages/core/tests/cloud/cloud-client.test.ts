import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifoCloud, cloudSafeEnv } from '../../src/cloud/cloud-client.js';
import { readSnapshotMetadata } from '../../src/kernel/vfs/snapshot.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { decompressGzip, parseTar } from '../../src/utils/archive.js';

interface Call {
	url: string;
	method: string;
	headers: Headers;
	body: Uint8Array | string | null;
}

/** A stand-in for the cloud API: records calls and answers from `routes`. */
function stubFetch(routes: Record<string, (call: Call) => unknown>): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		const body = init.body instanceof Uint8Array ? init.body : typeof init.body === 'string' ? init.body : null;
		const call = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body };
		calls.push(call);
		const key = `${call.method} ${new URL(url).pathname}`;
		const handler = routes[key];
		if (!handler) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
		const out = handler(call);
		if (out instanceof Response) return out;
		return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

const BOX = { name: 'my-api', port: 3000, start: 'node server.js', url: 'https://my-api-tunnel.lifo.sh', createdAt: '', updatedAt: '', savedAt: '', snapshotBytes: 1 };

describe('LifoCloud', () => {
	it('finds the cloud from the account server config', async () => {
		stubFetch({ 'GET /api/cli/config': () => ({ tunnelUrl: 'wss://t', cloudUrl: 'https://cloud.test/' }) });
		const cloud = await LifoCloud.connect({ token: 'lifo_x', baseUrl: 'https://acct.test' });
		expect(cloud.url).toBe('https://cloud.test');
	});

	it('says so when the account server has no cloud', async () => {
		stubFetch({ 'GET /api/cli/config': () => ({ tunnelUrl: 'wss://t', cloudUrl: null }) });
		await expect(LifoCloud.connect({ token: 'lifo_x', baseUrl: 'https://acct.test' })).rejects.toThrow(/isn't available/);
	});

	it('pushes a box as a snapshot without credentials', async () => {
		const box = await Sandbox.create({ env: { LIFO_AUTH_TOKEN: 'lifo_secret', LIFO_BASE_URL: 'https://acct.test', APP_MODE: 'prod' } });
		await box.fs.writeFile('/home/user/server.js', 'console.log(1)');
		await box.fs.mkdir('/home/user/.lifo', { recursive: true });
		await box.fs.writeFile('/home/user/.lifo/auth.json', '{"token":"lifo_secret"}');
		const calls = stubFetch({ 'PUT /v1/boxes/my-api': () => ({ box: BOX, boot: { bootMs: 5, listening: true } }) });

		const cloud = new LifoCloud({ token: 'lifo_x', url: 'https://cloud.test' });
		const res = await cloud.push('my-api', box, { start: 'node server.js', port: 3000, env: { A: '1', LIFO_AUTH_TOKEN: 'no' } });
		expect(res.box.url).toBe('https://my-api-tunnel.lifo.sh');

		const call = calls[0];
		expect(call.headers.get('authorization')).toBe('Bearer lifo_x');
		expect(JSON.parse(call.headers.get('x-lifo-box')!)).toMatchObject({ start: 'node server.js', port: 3000, env: { A: '1' } });
		expect(call.headers.get('x-lifo-box')).not.toContain('LIFO_AUTH_TOKEN');

		const snapshot = call.body as Uint8Array;
		const paths = parseTar(await decompressGzip(snapshot)).map((e) => e.path);
		expect(paths).toContain('home/user/server.js');
		expect(paths.some((p) => /\/\.lifo(\/|$)/.test(p))).toBe(false);
		const meta = await readSnapshotMetadata(snapshot);
		expect(meta?.env?.APP_MODE).toBe('prod');
		expect(meta?.env?.LIFO_AUTH_TOKEN).toBeUndefined();
		box.destroy();
	});

	it('runs commands, pulls and surfaces API errors', async () => {
		stubFetch({
			'POST /v1/boxes/my-api/exec': (c) => ({ stdout: `ran ${JSON.parse(c.body as string).cmd}`, stderr: '', exitCode: 0 }),
			'GET /v1/boxes/my-api/snapshot': () => new Response(new Uint8Array([1, 2, 3])),
			'GET /v1/boxes/nope': () => new Response(JSON.stringify({ error: 'No cloud box named "nope"' }), { status: 404 }),
		});
		const cloud = new LifoCloud({ token: 'lifo_x', url: 'https://cloud.test' });
		expect((await cloud.exec('my-api', 'ls')).stdout).toBe('ran ls');
		expect([...(await cloud.pull('my-api'))]).toEqual([1, 2, 3]);
		await expect(cloud.get('nope')).rejects.toThrow('No cloud box named "nope"');
	});

	it('cloudSafeEnv drops the keys the CLI passes in', () => {
		expect(cloudSafeEnv({ LIFO_AUTH_TOKEN: 'a', LIFO_BASE_URL: 'b', LIFO_CLOUD_URL: 'c', PATH: '/bin' })).toEqual({ PATH: '/bin' });
		// A cloud box's own database URL (set by the cloud at boot) carries a password: never pushed or pulled.
		const cloudDb = 'postgres://box_x:secret@db.lifo.internal:5432/box_x?sslmode=disable';
		const own = 'postgres://me:pw@db.example.com:5432/app';
		expect(cloudSafeEnv({ DATABASE_URL: cloudDb, LIFO_DATABASE_URL: cloudDb, MY_DB: own })).toEqual({ MY_DB: own });
	});
});

describe('lifo cloud (in a box)', () => {
	it('pushes the box, defaulting start to npm start, and lists', async () => {
		const calls = stubFetch({
			'PUT /v1/boxes/notes': () => ({ box: { ...BOX, name: 'notes', url: 'https://notes-tunnel.lifo.sh' }, boot: { bootMs: 9, listening: true } }),
			'GET /v1/boxes': () => ({ boxes: [{ ...BOX, name: 'notes', url: 'https://notes-tunnel.lifo.sh', savedAt: new Date().toISOString() }] }),
		});
		const box = await Sandbox.create({ env: { LIFO_AUTH_TOKEN: 'lifo_x', LIFO_CLOUD_URL: 'https://cloud.test' } });
		await box.fs.writeFile('/home/user/package.json', '{"scripts":{"start":"node index.js"}}');

		const push = await box.commands.run('lifo cloud push notes --port 8080');
		expect(push.exitCode).toBe(0);
		expect(push.stdout).toContain('https://notes-tunnel.lifo.sh');
		expect(JSON.parse(calls[0].headers.get('x-lifo-box')!)).toMatchObject({ start: 'npm start', port: 8080, cwd: '/home/user' });
		const meta = await readSnapshotMetadata(calls[0].body as Uint8Array);
		expect(meta?.env?.LIFO_AUTH_TOKEN).toBeUndefined();

		const ls = await box.commands.run('lifo cloud ls');
		expect(ls.stdout).toMatch(/notes\s+https:\/\/notes-tunnel\.lifo\.sh/);
		box.destroy();
	});

	it('needs a login and a name', async () => {
		const box = await Sandbox.create({ env: { LIFO_CLOUD_URL: 'https://cloud.test', LIFO_BASE_URL: 'https://acct.test' } });
		const r = await box.commands.run('lifo cloud ls');
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("lifo login");
		box.env.LIFO_AUTH_TOKEN = 'lifo_x';
		const r2 = await box.commands.run('lifo cloud logs');
		expect(r2.exitCode).toBe(1);
		expect(r2.stderr).toContain('name the box');
		box.destroy();
	});
});
