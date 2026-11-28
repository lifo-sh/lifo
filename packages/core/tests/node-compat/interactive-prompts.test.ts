// Interactive prompts (create-vite's clack, prompts, inquirer) in a terminal run.
import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import type { CommandContext, CommandOutputStream } from '../../src/commands/types.js';
import { TerminalStdin } from '../../src/shell/terminal-stdin.js';
import { createInteractiveStdin } from '../../src/node-compat/process.js';
import { createInterface } from '../../src/node-compat/readline.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function terminal() {
  const input = new TerminalStdin();
  const raw: boolean[] = [];
  const stdin = createInteractiveStdin(input, (v) => { raw.push(v); input.rawMode = v; }, true);
  return { input, raw, stdin };
}

describe('readline in terminal mode', () => {
  it('edits rl.line from keypresses, as clack reads it', async () => {
    const { input, raw, stdin } = terminal();
    const rl = createInterface({ input: stdin, terminal: true });
    expect(raw).toEqual([true]);
    expect(stdin.isPrompting()).toBe(true);

    const seen: string[] = [];
    // Attached after the interface, like clack: readline has already applied the key.
    stdin.on('keypress', () => seen.push(`${rl.line}|${rl.cursor}`));
    for (const k of ['a', 'b', '\x7f', 'c', '\x1b[D', 'X']) { input.feed(k); await tick(); }
    expect(seen).toEqual(['a|1', 'ab|2', 'a|1', 'ac|2', 'ac|1', 'aXc|2']);

    rl.write(null, { ctrl: true, name: 'u' }); // clack's "clear field"
    expect([rl.line, rl.cursor]).toEqual(['c', 0]);
    rl.write('ab'); // clack's initial value
    expect([rl.line, rl.cursor]).toEqual(['abc', 2]);

    const lines: string[] = [];
    rl.on('line', (l) => lines.push(l as string));
    input.feed('\r');
    await tick();
    expect(lines).toEqual(['abc']);
    expect(rl.line).toBe('');

    rl.close();
    expect(raw).toEqual([true, false]);
    expect(stdin.isPrompting()).toBe(false);
  });

  it('Ctrl+C closes the interface when nothing handles SIGINT', async () => {
    const { input, stdin } = terminal();
    const rl = createInterface({ input: stdin, terminal: true });
    let closed = false;
    rl.on('close', () => { closed = true; });
    input.feed('\x03');
    await tick();
    expect(closed).toBe(true);
    expect(stdin.isPrompting()).toBe(false);
  });

  it('echoes edits when given an output', async () => {
    const { input, stdin } = terminal();
    let out = '';
    const rl = createInterface({ input: stdin, output: { write: (d: string) => { out += d; } }, terminal: true, prompt: '? ' });
    for (const k of ['h', 'i', '\x1b[D', '!']) { input.feed(k); await tick(); }
    expect(rl.line).toBe('h!i');
    // Typing at the end echoes the key; an edit mid-line redraws it.
    expect(out).toBe('hi' + '\r\x1b[K? hi\x1b[1D' + '\r\x1b[K? h!i\x1b[1D');
    rl.close();
  });
});

describe('interactive stdin', () => {
  it('keeps input typed while paused for the next reader', async () => {
    const { input, stdin } = terminal();
    const got: string[] = [];
    const onData = (d: unknown) => got.push(String(d));
    stdin.on('data', onData);
    input.feed('a');
    await tick();
    stdin.pause();
    input.feed('b'); // arrives between two prompts
    await tick();
    expect(got).toEqual(['a']);
    stdin.resume();
    await tick();
    input.feed('c');
    await tick();
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('is not prompting without a terminal', () => {
    const stdin = createInteractiveStdin(new TerminalStdin(), undefined, false);
    const rl = createInterface({ input: stdin });
    expect(stdin.isPrompting()).toBe(false);
    rl.close();
  });
});

describe('node command with a terminal', () => {
  function context(vfs: VFS, args: string[], interactive?: TerminalStdin) {
    const stdout = { text: '', write(t: string) { this.text += t; } };
    const stderr = { text: '', write(t: string) { this.text += t; } };
    const ctx: CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } = {
      args,
      env: { HOME: '/home/user', USER: 'user', HOSTNAME: 'lifo' },
      cwd: '/tmp',
      vfs,
      stdout,
      stderr,
      signal: new AbortController().signal,
    };
    if (interactive) {
      ctx.stdin = interactive;
      ctx.setRawMode = (v: boolean) => { interactive.rawMode = v; };
    }
    return ctx;
  }

  function fs() {
    const vfs = new VFS();
    vfs.mkdir('/tmp');
    vfs.mkdir('/home/user', { recursive: true });
    return vfs;
  }

  it("require('process') is the run's process", async () => {
    const { default: node } = await import('../../src/commands/system/node.js');
    const vfs = fs();
    vfs.writeFile('/tmp/a.mjs', `import p, { stdin } from 'node:process';\nconsole.log(p === process, stdin === process.stdin);\n`);
    const ctx = context(vfs, ['/tmp/a.mjs']);
    expect(await node(ctx)).toBe(0);
    expect(ctx.stdout.text).toBe('true true\n');
  });

  it('waits for a prompt as long as the person takes, then ends', async () => {
    const { default: node } = await import('../../src/commands/system/node.js');
    const vfs = fs();
    // clack's shape: an ES module whose main finishes at once, stdin from node:process.
    vfs.writeFile('/tmp/ask.mjs', [
      `import readline from 'node:readline';`,
      `import { stdin } from 'node:process';`,
      `const rl = readline.createInterface({ input: stdin, terminal: true });`,
      `const onKey = (s, key) => { if (key.name === 'return') { stdin.removeListener('keypress', onKey); console.log('name: ' + answer); rl.close(); } else answer = rl.line; };`,
      `let answer = '';`,
      `stdin.on('keypress', onKey);`,
    ].join('\n'));
    const input = new TerminalStdin();
    const ctx = context(vfs, ['/tmp/ask.mjs'], input);
    const started = Date.now();
    let done = false;
    const run = node(ctx).then((code) => { done = true; return code; });
    await tick(1500); // well past the old 500 ms cut-off
    expect(done).toBe(false);
    for (const k of ['m', 'y', '\r']) { input.feed(k); await tick(5); }
    expect(await run).toBe(0);
    expect(ctx.stdout.text).toBe('name: my\n');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('still ends at once when nothing prompts', async () => {
    const { default: node } = await import('../../src/commands/system/node.js');
    const vfs = fs();
    vfs.writeFile('/tmp/plain.mjs', `console.log('hi');\n`);
    const ctx = context(vfs, ['/tmp/plain.mjs'], new TerminalStdin());
    const started = Date.now();
    expect(await node(ctx)).toBe(0);
    expect(ctx.stdout.text).toBe('hi\n');
    expect(Date.now() - started).toBeLessThan(400);
  });
});
