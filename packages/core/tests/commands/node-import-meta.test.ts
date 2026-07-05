import { describe, it, expect, beforeEach } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import type { CommandContext, CommandOutputStream } from '../../src/commands/types.js';

function createContext(vfs: VFS, args: string[], cwd = '/'): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
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
  };
}

/**
 * The ESM→CJS transform must rewrite import.meta in CODE while leaving it
 * intact inside STRING LITERAL content — string content may be client-facing
 * source (e.g. Vite emitting `import.meta.hot.accept()` into served modules).
 */
describe('node command — import.meta handling in ESM transform', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/home/user', { recursive: true });
    vfs.mkdir('/tmp');
  });

  async function runEsm(source: string): Promise<{ code: number; out: string; err: string }> {
    const { default: node } = await import('../../src/commands/system/node.js');
    vfs.writeFile('/tmp/main.mjs', source);
    const ctx = createContext(vfs, ['/tmp/main.mjs']);
    const code = await node(ctx);
    return { code, out: ctx.stdout.text, err: ctx.stderr.text };
  }

  it('replaces import.meta.url in plain code', async () => {
    const { code, out } = await runEsm('console.log(typeof import.meta.url);\nexport {};\n');
    expect(code).toBe(0);
    expect(out.trim()).toBe('string');
  });

  it('preserves import.meta inside template literal static text', async () => {
    const { code, out } = await runEsm(
      'const wrapper = `if (import.meta.hot) { import.meta.hot.accept() }`;\nconsole.log(wrapper);\nexport {};\n',
    );
    expect(code).toBe(0);
    expect(out).toContain('import.meta.hot.accept()');
    expect(out).not.toContain('__importMeta');
  });

  it('preserves import.meta inside plain string literals', async () => {
    const { code, out } = await runEsm(
      'console.log("uses import.meta.env here");\nexport {};\n',
    );
    expect(code).toBe(0);
    expect(out).toContain('import.meta.env');
    expect(out).not.toContain('__importMeta');
  });

  it('replaces import.meta inside template ${...} expressions', async () => {
    const { code, out } = await runEsm(
      'const msg = `url:${import.meta.url ? "yes" : "no"}`;\nconsole.log(msg);\nexport {};\n',
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe('url:yes');
  });

  it('survives a regex with braces inside a template expression (masker desync guard)', async () => {
    // A `{` inside a regex character class within ${...} desynced the old
    // brace-depth scanner and swallowed everything after it as one literal.
    const { code, out } = await runEsm(
      [
        "const value = '[x]';",
        'const s = `pad${(/^[{[]/.test(value) ? "open" : "other")}end`;',
        'console.log(s + " after");',
        'const t = `static import.meta stays`;',
        'console.log(t);',
        'export {};',
        '',
      ].join('\n'),
    );
    expect(code).toBe(0);
    expect(out).toContain('padopenend after');
    expect(out).toContain('static import.meta stays');
  });

  it('handles nested template literals inside expressions', async () => {
    const { code, out } = await runEsm(
      'const inner = "world";\nconst s = `a${`b${inner}`}c`;\nconsole.log(s);\nexport {};\n',
    );
    expect(code).toBe(0);
    expect(out.trim()).toBe('abworldc');
  });
});
