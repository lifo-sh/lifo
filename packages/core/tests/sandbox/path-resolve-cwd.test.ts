import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('path.resolve in a node run', () => {
	it("is based on the run's cwd, not the host process's (boxes in Node.js)", async () => {
		const box = await Sandbox.create();
		await box.fs.mkdir('/home/user/app', { recursive: true });
		await box.fs.writeFile('/home/user/app/a.mjs', "import path from 'node:path'; console.log(path.resolve('x'), path.posix.resolve('y'))");
		const esm = await box.commands.run('node a.mjs', { cwd: '/home/user/app' });
		expect(esm.stdout.trim()).toBe('/home/user/app/x /home/user/app/y');
		const cjs = await box.commands.run(`node -e "console.log(require('path').resolve('z'))"`, { cwd: '/home/user/app' });
		expect(cjs.stdout.trim()).toBe('/home/user/app/z');
		box.destroy();
	});
});
