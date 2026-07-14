import { describe, it, expect } from 'vitest';
import { VFS } from '@lifo-sh/core';
import type { CommandContext, CommandOutputStream } from '@lifo-sh/core';
import cal from '../src/index.js';

function createContext(vfs: VFS, args: string[], cwd = '/'): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return { args, env: { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo' }, cwd, vfs, stdout, stderr, signal: new AbortController().signal } as never;
}

describe('cal', () => {
  it('outputs current month calendar', async () => {
    const ctx = createContext(new VFS(), []);
    expect(await cal(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('Su Mo Tu We Th Fr Sa');
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    expect(months.some((m) => ctx.stdout.text.includes(m))).toBe(true);
  });

  it('outputs specific month and year', async () => {
    const ctx = createContext(new VFS(), ['12', '2025']);
    expect(await cal(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('December 2025');
    expect(ctx.stdout.text).toContain('Su Mo Tu We Th Fr Sa');
    expect(ctx.stdout.text).toContain(' 1');
  });

  it('outputs full year', async () => {
    const ctx = createContext(new VFS(), ['2025']);
    expect(await cal(ctx)).toBe(0);
    expect(ctx.stdout.text).toContain('January');
    expect(ctx.stdout.text).toContain('December');
  });
});
