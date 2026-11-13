import { describe, expect, it, afterEach } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { WorkerSandbox } from '../../src/sandbox/worker/client.js';
import { serveSandbox, type ServeSandboxOptions } from '../../src/sandbox/worker/host.js';
import type { Endpoint } from '../../src/sandbox/worker/rpc.js';
import type { ITerminal } from '../../src/terminal/ITerminal.js';

// The page and the box on the two ends of a MessageChannel, in one process: the same protocol a
// Web Worker uses, minus the worker. (Credential lockdown is tested on its own: it changes globals.)
const opened: Array<{ box: WorkerSandbox; ports: Array<{ close(): void }> }> = [];

async function boxPair(opts: Partial<Parameters<typeof WorkerSandbox.create>[0]> = {}, setup?: ServeSandboxOptions['setup']) {
	const { port1, port2 } = new MessageChannel();
	serveSandbox(port1 as unknown as Endpoint, { lockDownCredentials: false, routeConsole: false, setup });
	const box = await WorkerSandbox.create({ worker: port2 as unknown as Endpoint, ...opts });
	opened.push({ box, ports: [port1, port2] });
	return box;
}

afterEach(() => {
	for (const { box, ports } of opened.splice(0)) {
		box.destroy();
		setTimeout(() => ports.forEach((p) => p.close()), 300);
	}
});

class FakeTerminal implements ITerminal {
	cols = 100;
	rows = 30;
	out = '';
	private cbs: Array<(d: string) => void> = [];
	write(d: string) {
		this.out += d;
	}
	writeln(d: string) {
		this.out += d + '\r\n';
	}
	onData(cb: (d: string) => void) {
		this.cbs.push(cb);
	}
	type(d: string) {
		for (const cb of this.cbs) cb(d);
	}
	focus() {}
	clear() {
		this.out = '';
	}
}

const until = async (check: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 20));
	}
};

describe('WorkerSandbox over a MessageChannel', () => {
	it('runs commands with streaming output, and keeps cwd and env', async () => {
		const box = await boxPair({ env: { GREETING: 'hi' }, cwd: '/tmp' });
		expect(box.cwd).toBe('/tmp');
		const chunks: string[] = [];
		const r = await box.commands.run('echo $GREETING; echo oops >&2; mkdir -p /tmp/w && cd /tmp/w', { onStdout: (d) => chunks.push(d) });
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe('hi\n');
		expect(r.stderr).toContain('oops');
		expect(chunks.join('')).toContain('hi');
		await box.setEnv('X', '42');
		expect((await box.commands.run('echo $X')).stdout).toBe('42\n');
		expect(box.env.X).toBe('42');
	});

	it('reads and writes text and binary files, and moves snapshots between boxes', async () => {
		const a = await boxPair();
		await a.fs.mkdir('/home/user/p', { recursive: true });
		await a.fs.writeFile('/home/user/p/a.txt', 'hello');
		const bin = new Uint8Array([0, 1, 2, 250, 255]);
		await a.fs.writeFile('/home/user/p/b.bin', bin);
		expect(bin.byteLength).toBe(5); // the caller's bytes are copied, not taken
		expect(await a.fs.readFile('/home/user/p/a.txt')).toBe('hello');
		expect([...(await a.fs.readFile('/home/user/p/b.bin', null))]).toEqual([0, 1, 2, 250, 255]);
		expect((await a.fs.readdir('/home/user/p')).map((e) => e.name).sort()).toEqual(['a.txt', 'b.bin']);
		expect(await a.fs.exists('/home/user/p/nope')).toBe(false);

		const snap = await a.exportSnapshot();
		const b = await boxPair();
		await b.importSnapshot(snap);
		expect(await b.fs.readFile('/home/user/p/a.txt')).toBe('hello');
	});

	it('serves requests to a server in the box', async () => {
		const box = await boxPair({ files: { '/home/user/s.js': "require('http').createServer((q,r)=>r.end('from the box '+q.url)).listen(3000)" } });
		void box.commands.run('node /home/user/s.js &');
		await box.waitForPort(3000, { timeout: 5000 });
		expect(await box.ports()).toContain(3000);
		const res = await box.fetch('http://localhost:3000/x?y=1');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('from the box /x?y=1');
	});

	it('asks the page for the login token only when a command needs it', async () => {
		let asked = 0;
		const box = await boxPair({ auth: { baseUrl: 'http://example.test', getToken: async () => (asked++, null) } });
		expect(asked).toBe(0);
		await box.commands.run('lifo whoami');
		expect(asked).toBe(1);
		expect((await box.commands.run('env')).stdout).not.toMatch(/LIFO_AUTH_TOKEN/);
	});

	it('drives an interactive shell on a terminal in the page', async () => {
		const term = new FakeTerminal();
		const box = await boxPair({ terminal: term });
		await until(() => /\$ $/.test(term.out));
		term.type('echo typed-in-the-page\r');
		await until(() => term.out.includes('typed-in-the-page\r\n'));
		expect(box.cwd).toBe('/home/user');
	});

	it('aborts a running command', async () => {
		const box = await boxPair();
		const ac = new AbortController();
		const p = box.commands.run('sleep 30', { signal: ac.signal });
		setTimeout(() => ac.abort(), 100);
		const r = await p;
		expect(r.exitCode).not.toBe(0);
	});

	it('runs the worker entry setup with the page\'s extra, and refuses page-side register', async () => {
		const box = await boxPair({ setup: { greeting: 'from setup' } }, (b, extra) => {
			b.commands.register('hello', async (ctx) => {
				ctx.stdout.write(`${(extra as { greeting: string }).greeting}\n`);
				return 0;
			});
		});
		expect((await box.commands.run('hello')).stdout).toBe('from setup\n');
		expect(() => box.commands.register('x', () => 0)).toThrow(/registers its commands in the worker/);
	});

	it('fails calls after destroy', async () => {
		const box = await boxPair();
		box.destroy();
		await expect(box.commands.run('echo hi')).rejects.toThrow(/shut down/);
	});
});
