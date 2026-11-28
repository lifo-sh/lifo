// spawnSync / execSync / execFileSync: a box can't block a program on another command. A child
// whose output goes to the terminal runs once the program ends (create-vite's "install and
// start now"); anything else fails the way Node fails to spawn, naming what didn't run.
import { describe, it, expect } from 'vitest';
import { createChildProcess } from '../../src/node-compat/child_process.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('synchronous child processes', () => {
	const cp = createChildProcess(async () => '', async () => ({ stdout: '', stderr: '', code: 0 }));

	it('spawnSync returns an ENOSYS error result when nothing can run it later', () => {
		// create-vite: spawnSync('npm', ['install'], { stdio: 'inherit', cwd }); if (r.error) throw r.error
		const r = cp.spawnSync('npm', ['install'], { stdio: 'inherit', cwd: '/home/user/my-app' });
		expect(r.status).toBeNull();
		expect(r.error).toMatchObject({ code: 'ENOSYS', syscall: 'spawnSync npm', path: 'npm', spawnargs: ['install'] });
		expect(r.error?.message).toBe('[lifo] spawnSync can\'t run "npm install": a box can\'t pause a program while another command runs. Run it yourself in /home/user/my-app.');
		expect(r.error?.stack).toBe(`Error: ${r.error?.message}`);
		expect(Buffer.isBuffer(r.stdout) || r.stdout instanceof Uint8Array).toBe(true);
		expect(cp.spawnSync('git', { encoding: 'utf8' }).stdout).toBe('');
	});

	it('execSync and execFileSync throw it', () => {
		expect(() => cp.execSync('npm run dev')).toThrow(/\[lifo\] execSync can't run "npm run dev"/);
		expect(() => cp.execFileSync('git', ['status'], { cwd: '/w' })).toThrow(/execFileSync can't run "git status".*Run it yourself in \/w\./);
	});

	it('queues a child with inherited output to run after the program', () => {
		const queued: Array<[string, string | undefined]> = [];
		const later = createChildProcess(undefined, undefined, { runAfterExit: (line, cwd) => { queued.push([line, cwd]); } });

		const r = later.spawnSync('npm', ['install'], { stdio: 'inherit', cwd: '/home/user/my-app' });
		expect(r).toMatchObject({ status: 0, signal: null, stdout: null, stderr: null });
		expect(r.error).toBeUndefined();
		expect(later.spawnSync('echo', ["it's done"], { stdio: [0, 'inherit', 2] }).status).toBe(0);
		expect(later.spawnSync('echo $HOME', [], { stdio: 'inherit', shell: true }).status).toBe(0);
		expect(later.execSync('git init && git add -A', { stdio: 'inherit' })).toBeNull();
		expect(later.execFileSync('ls', ['-la'], { stdio: 'inherit', cwd: 'sub' })).toBeNull();
		expect(queued).toEqual([
			['npm install', '/home/user/my-app'],
			["echo 'it'\\''s done'", undefined],
			['echo $HOME', undefined],
			['git init && git add -A', undefined],
			['ls -la', 'sub'],
		]);

		// The program reads the output, or feeds input: it can't wait, so it fails as before.
		expect(later.spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).error).toMatchObject({ code: 'ENOSYS' });
		expect(later.spawnSync('cat', [], { stdio: 'inherit', input: 'x' }).error).toMatchObject({ code: 'ENOSYS' });
		expect(later.spawnSync('ls', [], { stdio: ['inherit', 'pipe', 'inherit'] }).error).toMatchObject({ code: 'ENOSYS' });
		expect(() => later.execSync('git rev-parse HEAD')).toThrow(/ENOSYS|can't run/);
		expect(queued).toHaveLength(5);
	});
});

describe('questions a box answers without running a command', () => {
	it("gives a package manager's registry, from the box's npm settings", () => {
		const cp = createChildProcess(undefined, undefined, { env: { NPM_REGISTRY: 'https://registry.example.com' } });
		expect(String(cp.execSync('npm config get registry --no-workspaces', { env: {} }))).toBe('https://registry.npmjs.org/\n');
		expect(cp.execSync('pnpm config get registry', { encoding: 'utf8' })).toBe('https://registry.example.com/\n');
		expect(cp.spawnSync('npm', ['config', 'get', 'registry'], { encoding: 'utf8' })).toMatchObject({ status: 0, stdout: 'https://registry.example.com/\n' });
		expect(() => cp.execSync('npm config get prefix')).toThrow(/ENOSYS|can't run/);
	});
});

describe('node runs queued children after the program ends', () => {
	async function run(script: string) {
		const box = await Sandbox.create({ persist: false });
		await box.fs.mkdir('/tmp/work', { recursive: true });
		await box.fs.writeFile('/tmp/prog.js', script);
		return box.commands.run('cd /tmp && node prog.js');
	}

	it('runs them in order, in their cwd, after the program, and returns the last code', async () => {
		const r = await run([
			`const { spawnSync } = require('child_process');`,
			`const a = spawnSync('pwd', [], { stdio: 'inherit', cwd: '/tmp/work' });`,
			`const b = spawnSync('echo', ['second'], { stdio: 'inherit' });`,
			`console.log('program done', a.status, b.status);`,
		].join('\n'));
		expect(r.stdout).toBe('program done 0 0\n/tmp/work\nsecond\n');
		expect(r.exitCode).toBe(0);
	});

	it('stops at the first failing child and returns its code', async () => {
		const r = await run([
			`const { spawnSync } = require('child_process');`,
			`spawnSync('exit 3', { stdio: 'inherit', shell: true });`,
			`spawnSync('echo', ['not reached'], { stdio: 'inherit' });`,
		].join('\n'));
		expect(r.stdout).not.toContain('not reached');
		expect(r.exitCode).toBe(3);
	});

	it('skips them, saying so, when the program fails', async () => {
		const r = await run([
			`require('child_process').execSync('echo never', { stdio: 'inherit' });`,
			`process.exit(2);`,
		].join('\n'));
		expect(r.stdout).toBe('');
		expect(r.stderr).toContain(`[lifo] skipped "echo never": a box runs a program's synchronous commands after it ends, and it ended with code 2.`);
		expect(r.exitCode).toBe(2);
	});
});
