import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('fetch in an ES module', () => {
	it("reaches a server in the box on localhost, like CommonJS's fetch", async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/srv.js', "require('http').createServer((q, s) => s.end('from the box ' + q.url)).listen(4321)");
		await box.commands.run('node /home/user/srv.js &');
		await box.waitForPort(4321, { timeout: 10_000 });
		await box.fs.writeFile('/home/user/get.mjs', "const r = await fetch('http://localhost:4321/esm'); console.log(await r.text())");
		const r = await box.commands.run('node /home/user/get.mjs');
		expect(r.stdout.trim()).toBe('from the box /esm');
		await box.fs.writeFile('/home/user/own.mjs', "const fetch = () => 'own'; console.log(fetch())");
		expect((await box.commands.run('node /home/user/own.mjs')).stdout.trim()).toBe('own');
		box.destroy();
	});
});
