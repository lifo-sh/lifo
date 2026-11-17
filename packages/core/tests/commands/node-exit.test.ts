import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

// When does a `node` run end? Like Node: once the program has nothing pending. These cover
// the work a program can leave behind, and that a short program returns quickly.
async function run(box: Sandbox, cmd: string) {
	const t0 = performance.now();
	const r = await box.commands.run(cmd, { timeout: 20_000 });
	return { ...r, ms: performance.now() - t0 };
}

describe('node run completion', () => {
	it('returns quickly when the program has nothing pending', async () => {
		const box = await Sandbox.create();
		const r = await run(box, 'node -e "1 + 1"');
		expect(r.exitCode).toBe(0);
		expect(r.ms).toBeLessThan(500);
	});

	it('waits for a pending setTimeout (CJS)', async () => {
		const box = await Sandbox.create();
		const r = await run(box, `node -e "setTimeout(() => console.log('late'), 400)"`);
		expect(r.stdout).toBe('late\n');
		expect(r.ms).toBeGreaterThanOrEqual(380);
		expect(r.ms).toBeLessThan(1500);
	});

	it('waits for chained timers and async functions', async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/chain.js', `
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			(async () => { for (let i = 0; i < 3; i++) { await sleep(150); console.log('tick', i); } })();
		`);
		const r = await run(box, 'node chain.js');
		expect(r.stdout).toBe('tick 0\ntick 1\ntick 2\n');
	});

	it('runs an interval until it is cleared', async () => {
		const box = await Sandbox.create();
		const r = await run(box, `node -e "let n = 0; const t = setInterval(() => { console.log(++n); if (n === 3) clearInterval(t); }, 50)"`);
		expect(r.stdout).toBe('1\n2\n3\n');
		expect(r.ms).toBeLessThan(1000);
	});

	it("doesn't wait for an unref'd timer", async () => {
		const box = await Sandbox.create();
		const r = await run(box, `node -e "setInterval(() => {}, 1000).unref(); console.log('done')"`);
		expect(r.stdout).toBe('done\n');
		expect(r.ms).toBeLessThan(500);
	});

	it('waits for top-level await in an ES module', async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/esm.mjs', `await new Promise((r) => setTimeout(r, 300)); console.log('esm done');`);
		const r = await run(box, 'node esm.mjs');
		expect(r.stdout).toBe('esm done\n');
	});

	it('waits for an outgoing http request to a server in the box', async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/server.js', `require('http').createServer((q, s) => setTimeout(() => s.end('pong'), 200)).listen(4321)`);
		await box.commands.run('node server.js &');
		await box.waitForPort(4321);
		await box.fs.writeFile('/home/user/client.js', `
			require('http').get('http://localhost:4321/', (res) => {
				let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => console.log('got ' + body));
			});
		`);
		const r = await run(box, 'node client.js');
		expect(r.stdout).toBe('got pong\n');
		const procs = box.shell.getProcessRegistry();
		for (const p of procs.getRunning()) procs.kill(p.pid);
	});

	it('waits for a WebAssembly compile', async () => {
		const box = await Sandbox.create();
		// The smallest valid module: magic + version.
		const r = await run(box, `node -e "WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])).then(() => console.log('wasm ok'))"`);
		expect(r.stdout).toBe('wasm ok\n');
	});

	it("isn't held open by a timer in another run", async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/ticker.js', `setInterval(() => {}, 100)`);
		await box.commands.run('node ticker.js &');
		const r = await run(box, 'node -e "console.log(2)"');
		expect(r.stdout).toBe('2\n');
		expect(r.ms).toBeLessThan(500);
		const procs = box.shell.getProcessRegistry();
		for (const p of procs.getRunning()) procs.kill(p.pid);
	});

	it('still ends a script that is just a server once the server closes', async () => {
		const box = await Sandbox.create();
		const r = await run(box, `node -e "const s = require('http').createServer(() => {}).listen(4322, () => setTimeout(() => s.close(() => console.log('closed')), 100))"`);
		expect(r.stdout).toBe('closed\n');
	});
});
