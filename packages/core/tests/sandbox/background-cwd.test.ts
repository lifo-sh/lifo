import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('background jobs keep the directory they started in', () => {
	it('commands.run("… &", { cwd }) runs the job in cwd, after run() has returned', async () => {
		const box = await Sandbox.create();
		await box.fs.mkdir('/home/user/app', { recursive: true });
		await box.commands.run('sleep 0.05 && pwd > where.txt &', { cwd: '/home/user/app' });
		// run() returned and put the shell back in /home/user before the job's pwd ran.
		await new Promise((r) => setTimeout(r, 200));
		expect((await box.fs.readFile('/home/user/app/where.txt')).trim()).toBe('/home/user/app');
		expect((await box.commands.run('pwd')).stdout.trim()).toBe('/home/user');
		box.destroy();
	});

	it('a later cd in the shell does not move a running job', async () => {
		const box = await Sandbox.create();
		await box.commands.run('mkdir -p /tmp/a /tmp/b && cd /tmp/a && (sleep 0.05; touch made-here) &');
		await box.commands.run('cd /tmp/b');
		await new Promise((r) => setTimeout(r, 200));
		expect(box.kernel.vfs.exists('/tmp/a/made-here')).toBe(true);
		expect(box.kernel.vfs.exists('/tmp/b/made-here')).toBe(false);
		box.destroy();
	});
});
