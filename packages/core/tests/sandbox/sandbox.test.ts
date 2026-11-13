import { describe, it, expect, afterEach } from 'vitest';
import { Sandbox } from '../../src/sandbox/index.js';

describe('Sandbox', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  describe('create and destroy', () => {
    it('creates a headless sandbox', async () => {
      sandbox = await Sandbox.create();
      expect(sandbox).toBeDefined();
      expect(sandbox.commands).toBeDefined();
      expect(sandbox.fs).toBeDefined();
      expect(sandbox.kernel).toBeDefined();
      expect(sandbox.shell).toBeDefined();
    });

    it('default cwd is /home/user', async () => {
      sandbox = await Sandbox.create();
      expect(sandbox.cwd).toBe('/home/user');
    });

    it('respects custom cwd option', async () => {
      sandbox = await Sandbox.create({ cwd: '/tmp' });
      expect(sandbox.cwd).toBe('/tmp');
    });

    it('cwd is read/write', async () => {
      sandbox = await Sandbox.create();
      sandbox.cwd = '/tmp';
      expect(sandbox.cwd).toBe('/tmp');
    });

    it('respects custom env', async () => {
      sandbox = await Sandbox.create({ env: { EDITOR: 'vim' } });
      expect(sandbox.env.EDITOR).toBe('vim');
      // Default env should also be present
      expect(sandbox.env.HOME).toBe('/home/user');
    });

    it('pre-populates files', async () => {
      sandbox = await Sandbox.create({
        files: { '/home/user/test.txt': 'hello world' },
      });
      const content = await sandbox.fs.readFile('/home/user/test.txt');
      expect(content).toBe('hello world');
    });

    it('pre-populates files with nested paths', async () => {
      sandbox = await Sandbox.create({
        files: { '/home/user/deep/nested/file.txt': 'nested content' },
      });
      const content = await sandbox.fs.readFile('/home/user/deep/nested/file.txt');
      expect(content).toBe('nested content');
    });

    it('destroy cleans up', async () => {
      sandbox = await Sandbox.create();
      sandbox.destroy();
      // Should not throw after destroy
    });
  });

  describe('commands.run()', () => {
    it('runs echo and captures stdout', async () => {
      sandbox = await Sandbox.create();
      const result = await sandbox.commands.run('echo hello');
      expect(result.stdout).toBe('hello\n');
      expect(result.exitCode).toBe(0);
    });

    it('captures exit code for failing commands', async () => {
      sandbox = await Sandbox.create();
      const result = await sandbox.commands.run('false');
      expect(result.exitCode).toBe(1);
    });

    it('captures stderr for command not found', async () => {
      sandbox = await Sandbox.create();
      const result = await sandbox.commands.run('nonexistent_cmd_xyz');
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('command not found');
    });

    it('preserves shell state across calls', async () => {
      sandbox = await Sandbox.create();
      await sandbox.commands.run('cd /tmp');
      const result = await sandbox.commands.run('pwd');
      expect(result.stdout).toBe('/tmp\n');
    });

    it('preserves env vars across calls', async () => {
      sandbox = await Sandbox.create();
      await sandbox.commands.run('export FOO=bar');
      const result = await sandbox.commands.run('echo $FOO');
      expect(result.stdout).toBe('bar\n');
    });

    it('supports chained commands with &&', async () => {
      sandbox = await Sandbox.create();
      const result = await sandbox.commands.run('echo first && echo second');
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
    });

    it('supports pipes', async () => {
      sandbox = await Sandbox.create();
      const result = await sandbox.commands.run('echo hello | cat');
      expect(result.stdout).toBe('hello\n');
    });

    it('supports redirects', async () => {
      sandbox = await Sandbox.create();
      await sandbox.commands.run('echo content > /tmp/redir.txt');
      const content = await sandbox.fs.readFile('/tmp/redir.txt');
      expect(content).toContain('content');
    });
  });

  describe('serialized execution', () => {
    it('queues concurrent run() calls', async () => {
      sandbox = await Sandbox.create();
      const order: number[] = [];

      const p1 = sandbox.commands.run('echo first').then((r) => { order.push(1); return r; });
      const p2 = sandbox.commands.run('echo second').then((r) => { order.push(2); return r; });
      const p3 = sandbox.commands.run('echo third').then((r) => { order.push(3); return r; });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.stdout).toBe('first\n');
      expect(r2.stdout).toBe('second\n');
      expect(r3.stdout).toBe('third\n');
      expect(order).toEqual([1, 2, 3]);
    });
  });
});

describe('Sandbox env', () => {
	it('box.env is what commands see, and a snapshot restores it', async () => {
		const a = await Sandbox.create({ env: { GREETING: 'hello' } });
		a.env.EXTRA = 'set later';
		expect((await a.commands.run('echo "$GREETING $EXTRA"')).stdout).toBe('hello set later\n');
		const b = await Sandbox.create();
		await b.importSnapshot(await a.exportSnapshot());
		expect((await b.commands.run('echo "$GREETING $EXTRA"')).stdout).toBe('hello set later\n');
	});
});
