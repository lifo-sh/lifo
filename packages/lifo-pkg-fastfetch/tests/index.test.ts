import { describe, it, expect } from 'vitest';
import fastfetch from '../src/index.js';

function ctx(args: string[] = []) {
  let out = '';
  return {
    ctx: {
      args,
      env: { USER: 'user', HOSTNAME: 'lifo', COLUMNS: '80', LINES: '24', HOME: '/home/user' },
      cwd: '/home/user',
      vfs: { readFile() { throw new Error('ENOENT'); }, exists: () => false, stat() { throw new Error('ENOENT'); } },
      stdout: { write(s: string) { out += s; } },
      stderr: { write(s: string) { out += s; } },
      signal: new AbortController().signal,
    } as never,
    get out() { return out; },
  };
}

describe('lifo-pkg-fastfetch', () => {
  it('renders a system-info screen', async () => {
    const c = ctx();
    const code = await fastfetch(c.ctx);
    expect(code).toBe(0);
    expect(c.out.length).toBeGreaterThan(0);
    // strips ANSI, expects the user@hostname header
    expect(c.out.replace(/\x1b\[[0-9;]*m/g, '')).toContain('user@lifo');
  });

  it('prints usage with --help', async () => {
    const c = ctx(['--help']);
    await fastfetch(c.ctx);
    expect(c.out).toContain('Usage: fastfetch');
  });
});
