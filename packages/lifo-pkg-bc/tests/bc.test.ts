import { describe, it, expect } from 'vitest';
import { VFS } from '@lifo-sh/core';
import type { CommandContext, CommandOutputStream, CommandInputStream } from '@lifo-sh/core';
import bc from '../src/index.js';

function createContext(vfs: VFS, args: string[], cwd = '/', stdin?: CommandInputStream): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return { args, env: { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo' }, cwd, vfs, stdout, stderr, signal: new AbortController().signal, stdin } as never;
}
function createStdin(content: string): CommandInputStream {
  let read = false;
  return { async read() { if (read) return null; read = true; return content; }, async readAll() { return content; } };
}
const run = async (input?: string, args: string[] = []) => {
  const ctx = createContext(new VFS(), args, '/', input !== undefined ? createStdin(input) : undefined);
  const code = await bc(ctx);
  return { code, out: ctx.stdout.text.trim() };
};
const last = (s: string) => s.split('\n').pop();

describe('bc', () => {
  it('evaluates simple addition', async () => { const r = await run('2+3'); expect(r.code).toBe(0); expect(r.out).toBe('5'); });
  it('evaluates multiplication', async () => { expect((await run('6*7')).out).toBe('42'); });
  it('evaluates power', async () => { expect((await run('2^10')).out).toBe('1024'); });
  it('evaluates sqrt', async () => { expect((await run('sqrt(144)')).out).toBe('12'); });
  it('supports variables', async () => { expect(last((await run('a = 5\na * 2')).out)).toBe('10'); });
  it('supports scale for decimal precision', async () => { expect(last((await run('scale = 2\n10/3')).out)).toBe('3.33'); });
  it('supports -e expression', async () => { expect((await run(undefined, ['-e', '2+3'])).out).toBe('5'); });
  it('handles integer division (scale=0)', async () => { expect((await run('10/3')).out).toBe('3'); });
  it('handles parentheses', async () => { expect((await run('(2+3)*4')).out).toBe('20'); });
});
