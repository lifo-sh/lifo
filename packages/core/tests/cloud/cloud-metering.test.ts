import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifoCloud } from '../../src/cloud/cloud-client.js';
import { parseDuration, fmtDuration, sparkline } from '../../src/commands/system/lifo-cloud.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

interface Call {
	url: string;
	method: string;
	headers: Headers;
	body: string | null;
}

function stubFetch(routes: Record<string, (call: Call) => unknown>): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
		const url = String(input);
		const call = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : null };
		calls.push(call);
		const handler = routes[`${call.method} ${new URL(url).pathname}`];
		if (!handler) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
		const out = handler(call);
		if (out instanceof Response) return out;
		return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
	});
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

const BOX = { name: 'my-api', port: 3000, start: 'node server.js', url: 'https://my-api-tunnel.lifo.sh', createdAt: '', updatedAt: '', savedAt: '', snapshotBytes: 2048, sleepAfter: 300, awake: true, since: Date.now() - 90_000 };

function metrics(range = '1h') {
	const now = Date.now();
	const points = Array.from({ length: 60 }, (_, i) => ({ t: now - (60 - i) * 60_000, cpuMs: i === 59 ? 1500 : i % 10, wallMs: 0, requests: i > 50 ? 4 : 0, errors: i === 59 ? 1 : 0, bytesIn: 10, bytesOut: 100, memMB: i > 50 ? 12.5 : 0, awake: i > 50 ? 1 : 0 }));
	return { range, step: 60, points, memEstimated: false, uptime: { awake: true, since: now - 90_000, lastWake: now - 90_000, lastSleep: now - 3_600_000, bootCount: 3, awakeSeconds: 540 }, settings: { sleepAfter: 300 }, storageBytes: 2048 };
}

describe('LifoCloud metering', () => {
	it('reads metrics, events and usage, and changes sleepAfter', async () => {
		const calls = stubFetch({
			'GET /v1/boxes/my-api/metrics': () => metrics(),
			'GET /v1/boxes/my-api/events': () => ({ events: [{ t: 1, type: 'sleep', reason: 'idle' }] }),
			'PATCH /v1/boxes/my-api': (c) => ({ box: { ...BOX, sleepAfter: JSON.parse(c.body!).sleepAfter } }),
			'GET /v1/usage': () => ({ from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', totals: { awakeSeconds: 540, cpuMs: 1600, requests: 36, bytesOut: 6000, bytesIn: 600, storageGBHours: 0.0001 }, boxes: [] }),
		});
		const cloud = new LifoCloud({ token: 'lifo_x', url: 'https://cloud.test' });

		const m = await cloud.metrics('my-api', '24h');
		expect(m.uptime.bootCount).toBe(3);
		expect(calls[0].url).toBe('https://cloud.test/v1/boxes/my-api/metrics?range=24h');
		expect((await cloud.events('my-api', 5))[0].reason).toBe('idle');
		expect(calls[1].url).toContain('limit=5');
		expect((await cloud.update('my-api', { sleepAfter: 1800 })).box.sleepAfter).toBe(1800);
		expect(calls[2].method).toBe('PATCH');
		expect(JSON.parse(calls[2].body!)).toEqual({ sleepAfter: 1800 });
		const u = await cloud.usage({ from: new Date('2026-11-01T00:00:00Z') });
		expect(u.totals.requests).toBe(36);
		expect(calls[3].url).toBe('https://cloud.test/v1/usage?from=2026-11-01T00%3A00%3A00.000Z');
		await cloud.usage();
		expect(calls[4].url).toBe('https://cloud.test/v1/usage');
		for (const c of calls) expect(c.headers.get('authorization')).toBe('Bearer lifo_x');
	});

	it('sends sleepAfter with a push only when it is given', async () => {
		const calls = stubFetch({ 'PUT /v1/boxes/my-api': () => ({ box: BOX, boot: { bootMs: 1, listening: true } }) });
		const cloud = new LifoCloud({ token: 'lifo_x', url: 'https://cloud.test' });
		await cloud.push('my-api', new Uint8Array([1]), { port: 3000 });
		await cloud.push('my-api', new Uint8Array([1]), { port: 3000, sleepAfter: null });
		expect('sleepAfter' in JSON.parse(calls[0].headers.get('x-lifo-box')!)).toBe(false);
		expect(JSON.parse(calls[1].headers.get('x-lifo-box')!).sleepAfter).toBeNull();
	});
});

describe('duration and sparkline helpers', () => {
	it('parses durations', () => {
		expect(parseDuration('90')).toBe(90);
		expect(parseDuration('90s')).toBe(90);
		expect(parseDuration('10m')).toBe(600);
		expect(parseDuration('1.5h')).toBe(5400);
		expect(parseDuration('1d')).toBe(86400);
		expect(parseDuration('never')).toBeNull();
		expect(parseDuration('soon')).toBeUndefined();
		expect(parseDuration(undefined)).toBeUndefined();
		expect(fmtDuration(600)).toBe('10m');
		expect(fmtDuration(5400)).toBe('1.5h');
		expect(fmtDuration(null)).toBe('never');
	});

	it('draws a sparkline no wider than asked', () => {
		const s = sparkline(Array.from({ length: 60 }, (_, i) => i), 30);
		expect(s.length).toBe(30);
		expect(s.at(-1)).toBe('█');
		expect(sparkline([0, 0, 0])).toBe('   ');
	});
});

describe('lifo cloud stats, config and usage', () => {
	async function box() {
		const b = await Sandbox.create({ env: { LIFO_AUTH_TOKEN: 'lifo_x', LIFO_BASE_URL: 'https://acct.test', LIFO_CLOUD_URL: 'https://cloud.test' } });
		return b;
	}

	it('stats prints a summary with sparklines', async () => {
		stubFetch({ 'GET /v1/boxes/my-api/metrics': () => metrics() });
		const b = await box();
		const r = await b.commands.run('lifo cloud stats my-api');
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain('awake');
		expect(r.stdout).toMatch(/requests\s+.*36 \(1 errors\)/);
		expect(r.stdout).toContain('peak 12.5 MB');
		expect(r.stdout).toContain('sleeps    after 5m idle');
		expect(r.stdout).toMatch(/boots\s+3/);
		expect((await b.commands.run('lifo cloud stats my-api --range 2y')).exitCode).toBe(1);
		b.destroy();
	});

	it('config reads and sets sleepAfter; push takes --sleep-after', async () => {
		const calls = stubFetch({
			'GET /v1/boxes/my-api': () => ({ box: BOX, status: { awake: true, listening: true, exitCode: null } }),
			'PATCH /v1/boxes/my-api': (c) => ({ box: { ...BOX, sleepAfter: JSON.parse(c.body!).sleepAfter } }),
			'PUT /v1/boxes/my-api': () => ({ box: { ...BOX, sleepAfter: 7200 }, boot: { bootMs: 1, listening: true } }),
		});
		const b = await box();
		expect((await b.commands.run('lifo cloud config my-api')).stdout).toContain('sleeps after 5m idle');
		const set = await b.commands.run('lifo cloud config my-api --sleep-after 30m');
		expect(set.stdout).toContain('now sleeps after 30m idle');
		expect(JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!)).toEqual({ sleepAfter: 1800 });
		expect((await b.commands.run('lifo cloud config my-api --sleep-after later')).exitCode).toBe(1);
		const push = await b.commands.run('lifo cloud push my-api --port 3000 --sleep-after 2h');
		expect(push.exitCode).toBe(0);
		expect(push.stdout).toContain('sleeps after 2h idle');
		expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.headers.get('x-lifo-box')!).sleepAfter).toBe(7200);
		b.destroy();
	});

	it('usage prints this period per box', async () => {
		stubFetch({
			'GET /v1/usage': () => ({
				from: '2026-11-01T00:00:00.000Z',
				to: '2026-12-01T00:00:00.000Z',
				totals: { awakeSeconds: 7200, cpuMs: 4200, requests: 900, bytesOut: 5_000_000, bytesIn: 1000, storageGBHours: 0.12 },
				boxes: [
					{ name: 'a', awakeSeconds: 3600, cpuMs: 2100, requests: 450, bytesOut: 2_500_000, bytesIn: 500, storageGBHours: 0.06 },
					{ name: 'b', awakeSeconds: 3600, cpuMs: 2100, requests: 450, bytesOut: 2_500_000, bytesIn: 500, storageGBHours: 0.06 },
				],
			}),
		});
		const b = await box();
		const r = await b.commands.run('lifo cloud usage');
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain('Usage 2026-11-01 to 2026-12-01');
		expect(r.stdout).toMatch(/total\s+2h awake\s+4\.2 s CPU\s+900 req/);
		b.destroy();
	});
});
