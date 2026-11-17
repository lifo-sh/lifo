import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import type { CommandContext, CommandOutputStream } from '../../src/commands/types.js';

function createContext(
  vfs: VFS,
  args: string[],
  cwd = '/',
  env: Record<string, string> = { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo' },
): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return {
    args,
    env,
    cwd,
    vfs,
    stdout,
    stderr,
    signal: new AbortController().signal,
  };
}

describe('env', () => {
  it('lists environment variables', async () => {
    const vfs = new VFS();
    const { default: env } = await import('../../src/commands/system/env.js');
    const ctx = createContext(vfs, [], '/', { HOME: '/home/user', USER: 'user', SHELL: '/bin/sh' });
    const code = await env(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('HOME=/home/user');
    expect(ctx.stdout.text).toContain('USER=user');
    expect(ctx.stdout.text).toContain('SHELL=/bin/sh');
  });
});

describe('uname', () => {
  it('shows system name by default', async () => {
    const vfs = new VFS();
    const { default: uname } = await import('../../src/commands/system/uname.js');
    const ctx = createContext(vfs, []);
    const code = await uname(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('Lifo\n');
  });

  it('shows all info with -a', async () => {
    const vfs = new VFS();
    const { default: uname } = await import('../../src/commands/system/uname.js');
    const ctx = createContext(vfs, ['-a']);
    const code = await uname(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('Lifo 1.0.0 wasm\n');
  });

  it('shows specific flags', async () => {
    const vfs = new VFS();
    const { default: uname } = await import('../../src/commands/system/uname.js');
    const ctx = createContext(vfs, ['-s']);
    const code = await uname(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('Lifo\n');
  });
});

describe('date', () => {
  it('returns a non-empty string', async () => {
    const vfs = new VFS();
    const { default: date } = await import('../../src/commands/system/date.js');
    const ctx = createContext(vfs, []);
    const code = await date(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text.trim().length).toBeGreaterThan(0);
  });

  it('supports format string', async () => {
    const vfs = new VFS();
    const { default: date } = await import('../../src/commands/system/date.js');
    const ctx = createContext(vfs, ['+%Y']);
    const code = await date(ctx);
    expect(code).toBe(0);
    const year = parseInt(ctx.stdout.text.trim(), 10);
    expect(year).toBeGreaterThanOrEqual(2024);
  });
});

describe('sleep', () => {
  it('resolves after delay', async () => {
    const vfs = new VFS();
    const { default: sleep } = await import('../../src/commands/system/sleep.js');
    const ctx = createContext(vfs, ['0.01']);
    const start = Date.now();
    const code = await sleep(ctx);
    expect(code).toBe(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });

  it('errors without argument', async () => {
    const vfs = new VFS();
    const { default: sleep } = await import('../../src/commands/system/sleep.js');
    const ctx = createContext(vfs, []);
    const code = await sleep(ctx);
    expect(code).toBe(1);
  });
});

describe('whoami', () => {
  it('returns USER env value', async () => {
    const vfs = new VFS();
    const { default: whoami } = await import('../../src/commands/system/whoami.js');
    const ctx = createContext(vfs, []);
    const code = await whoami(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('user\n');
  });
});

describe('hostname', () => {
  it('returns HOSTNAME env value', async () => {
    const vfs = new VFS();
    const { default: hostname } = await import('../../src/commands/system/hostname.js');
    const ctx = createContext(vfs, []);
    const code = await hostname(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('lifo\n');
  });
});

describe('uptime', () => {
  it('returns uptime string', async () => {
    const vfs = new VFS();
    const { default: uptime } = await import('../../src/commands/system/uptime.js');
    const ctx = createContext(vfs, []);
    const code = await uptime(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('up ');
  });
});

describe('which', () => {
  // Answers from the real command table: built-ins, and commands registered later.
  const makeWhich = async () => {
    const { createDefaultRegistry } = await import('../../src/commands/registry.js');
    const { createWhichCommand } = await import('../../src/commands/system/which.js');
    const registry = createDefaultRegistry();
    registry.register('git', async () => 0);
    return createWhichCommand(registry);
  };

  it('finds a command registered after boot (a package)', async () => {
    const which = await makeWhich();
    const ctx = createContext(new VFS(), ['git']);
    expect(await which(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('git');
  });

  it('finds a known command', async () => {
    const vfs = new VFS();
    const which = await makeWhich();
    const ctx = createContext(vfs, ['cat']);
    const code = await which(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('cat');
  });

  it('finds a builtin', async () => {
    const vfs = new VFS();
    const which = await makeWhich();
    const ctx = createContext(vfs, ['cd']);
    const code = await which(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('built-in');
  });

  it('returns 1 for unknown command', async () => {
    const vfs = new VFS();
    const which = await makeWhich();
    const ctx = createContext(vfs, ['nonexistent']);
    const code = await which(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('not found');
  });
});

describe('free', () => {
  it('returns output without error', async () => {
    const vfs = new VFS();
    const { default: free } = await import('../../src/commands/system/free.js');
    const ctx = createContext(vfs, []);
    const code = await free(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text.length).toBeGreaterThan(0);
  });
});
