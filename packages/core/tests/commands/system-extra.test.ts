import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { JobTable } from '../../src/shell/jobs.js';
import { CommandRegistry } from '../../src/commands/registry.js';
import type { CommandContext, CommandOutputStream, CommandInputStream } from '../../src/commands/types.js';

function createContext(
  vfs: VFS,
  args: string[],
  cwd = '/',
  stdin?: CommandInputStream,
): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return {
    args,
    env: { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo' },
    cwd,
    vfs,
    stdout,
    stderr,
    signal: new AbortController().signal,
    stdin,
  };
}

function createStdin(content: string): CommandInputStream {
  let read = false;
  return {
    async read() { if (read) return null; read = true; return content; },
    async readAll() { return content; },
  };
}

describe('ps', () => {
  it('shows shell and ps itself with no jobs', async () => {
    const jobTable = new JobTable();
    const { createPsCommand } = await import('../../src/commands/system/ps.js');
    const ps = createPsCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, []);
    const code = await ps(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('PID');
    expect(ctx.stdout.text).toContain('sh');
    expect(ctx.stdout.text).toContain('ps');
  });

  it('shows background jobs', async () => {
    const jobTable = new JobTable();
    const ac = new AbortController();
    jobTable.add('sleep 100', new Promise(() => {}), ac);
    const { createPsCommand } = await import('../../src/commands/system/ps.js');
    const ps = createPsCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, []);
    const code = await ps(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('sleep');
  });
});

describe('top', () => {
  it('shows system snapshot', async () => {
    const jobTable = new JobTable();
    const { createTopCommand } = await import('../../src/commands/system/top.js');
    const top = createTopCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, []);
    const code = await top(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('top');
    expect(ctx.stdout.text).toContain('Tasks');
    expect(ctx.stdout.text).toContain('sh');
    expect(ctx.stdout.text).toContain('PID');
  });
});

describe('kill', () => {
  it('kills a job by %N', async () => {
    const jobTable = new JobTable();
    const ac = new AbortController();
    jobTable.add('sleep 100', new Promise(() => {}), ac);
    const { createKillCommand } = await import('../../src/commands/system/kill.js');
    const kill = createKillCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, ['%1']);
    const code = await kill(ctx);
    expect(code).toBe(0);
    expect(ac.signal.aborted).toBe(true);
  });

  it('kills a job by PID', async () => {
    const jobTable = new JobTable();
    const ac = new AbortController();
    jobTable.add('sleep 100', new Promise(() => {}), ac);
    const { createKillCommand } = await import('../../src/commands/system/kill.js');
    const kill = createKillCommand(jobTable);
    const vfs = new VFS();
    // PID = jobId + 1 = 2
    const ctx = createContext(vfs, ['2']);
    const code = await kill(ctx);
    expect(code).toBe(0);
    expect(ac.signal.aborted).toBe(true);
  });

  it('refuses to kill PID 1 (shell)', async () => {
    const jobTable = new JobTable();
    const { createKillCommand } = await import('../../src/commands/system/kill.js');
    const kill = createKillCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, ['1']);
    const code = await kill(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('not permitted');
  });

  it('lists signals with -l', async () => {
    const jobTable = new JobTable();
    const { createKillCommand } = await import('../../src/commands/system/kill.js');
    const kill = createKillCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, ['-l']);
    const code = await kill(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('TERM');
    expect(ctx.stdout.text).toContain('KILL');
  });

  it('errors on non-existent job', async () => {
    const jobTable = new JobTable();
    const { createKillCommand } = await import('../../src/commands/system/kill.js');
    const kill = createKillCommand(jobTable);
    const vfs = new VFS();
    const ctx = createContext(vfs, ['%99']);
    const code = await kill(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('no such process');
  });
});

describe('help', () => {
  it('lists commands grouped by category', async () => {
    const registry = new CommandRegistry();
    registry.register('ls', async () => 0);
    registry.register('cat', async () => 0);
    const { createHelpCommand } = await import('../../src/commands/system/help.js');
    const help = createHelpCommand(registry);
    const vfs = new VFS();
    const ctx = createContext(vfs, []);
    const code = await help(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('Lifo Commands');
    expect(ctx.stdout.text).toContain('File system');
    expect(ctx.stdout.text).toContain('Shell builtins');
    expect(ctx.stdout.text).toContain('ls');
  });
});

describe('watch', () => {
  it('errors with no command', async () => {
    const registry = new CommandRegistry();
    const { createWatchCommand } = await import('../../src/commands/system/watch.js');
    const watch = createWatchCommand(registry);
    const vfs = new VFS();
    const ctx = createContext(vfs, []);
    const code = await watch(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('missing command');
  });

  it('errors on unknown command', async () => {
    const registry = new CommandRegistry();
    const { createWatchCommand } = await import('../../src/commands/system/watch.js');
    const watch = createWatchCommand(registry);
    const vfs = new VFS();
    const ctx = createContext(vfs, ['nonexistent']);
    const code = await watch(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('command not found');
  });
});
