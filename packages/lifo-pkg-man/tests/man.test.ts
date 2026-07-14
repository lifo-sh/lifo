import { describe, it, expect } from 'vitest';
import { VFS } from '@lifo-sh/core';
import type { CommandContext, CommandOutputStream } from '@lifo-sh/core';
import man from '../src/index.js';

function createContext(vfs: VFS, args: string[], cwd = '/'): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return { args, env: { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo' }, cwd, vfs, stdout, stderr, signal: new AbortController().signal } as never;
}

describe('man', () => {
  it('shows manual page for a command', async () => {
    const ctx = createContext(new VFS(), ['ls']);
    expect(await man(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('NAME');
    expect(ctx.stdout.text).toContain('SYNOPSIS');
    expect(ctx.stdout.text).toContain('DESCRIPTION');
    expect(ctx.stdout.text).toContain('ls');
  });

  it('errors on unknown command', async () => {
    const ctx = createContext(new VFS(), ['nonexistent']);
    expect(await man(ctx)).toBe(1);
    expect(ctx.stderr.text).toContain('no manual entry');
  });

  it('searches with -k', async () => {
    const ctx = createContext(new VFS(), ['-k', 'file']);
    expect(await man(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('(1)');
  });

  it('errors with no args', async () => {
    const ctx = createContext(new VFS(), []);
    expect(await man(ctx)).toBe(1);
  });
});
