import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { CommandRegistry } from '../../src/commands/registry.js';
import { Interpreter, type BuiltinFn } from '../../src/shell/interpreter.js';
import grep from '../../src/commands/text/grep.js';
import printf from '../../src/commands/io/printf.js';
import { ProcessRegistry } from '../../src/shell/ProcessRegistry.js';

/**
 * Quoted empty words are arguments; unquoted empty expansions are not (POSIX sh).
 *
 * `grep -c "" file` counts lines. It used to fail with "missing file operand": grep tested its
 * pattern for truthiness, skipped "", and took the file as the pattern. Each such failure cost an
 * agent a retry.
 */
function createTestShell() {
  const vfs = new VFS();
  const registry = new CommandRegistry();
  registry.register('grep', grep);
  registry.register('printf', printf);
  const env: Record<string, string> = { HOME: '/home/user', USER: 'user' };
  let cwd = '/';
  let output = '';
  const builtins = new Map<string, BuiltinFn>();
  // Prints its argv exactly, so a dropped or merged argument is visible.
  builtins.set('argv', async (args, stdout) => {
    stdout.write(JSON.stringify(args) + '\n');
    return 0;
  });

  const interpreter = new Interpreter({
    env,
    getCwd: () => cwd,
    setCwd: (c) => { cwd = c; },
    vfs,
    registry,
    builtins,
    processRegistry: new ProcessRegistry(),
    jobTable: { add: () => 0, list: () => [], get: () => undefined, remove: () => {}, collectDone: () => [] } as any,
    writeToTerminal: (text) => { output += text; },
  });

  vfs.writeFile('/a.txt', 'one\ntwo\nthree\n');
  const run = async (line: string) => {
    output = '';
    await interpreter.executeLine(line);
    return output;
  };
  return { run };
}

describe('empty arguments', () => {
  it('keeps "" and \'\' as empty arguments', async () => {
    const { run } = createTestShell();
    expect(await run(`argv "" x '' y`)).toBe('["","x","","y"]\n');
  });

  it('keeps a quoted empty expansion and drops an unquoted one', async () => {
    const { run } = createTestShell();
    expect(await run('E=; argv "$E" b')).toBe('["","b"]\n');
    expect(await run('E=; argv $E b')).toBe('["b"]\n');
    expect(await run('argv $UNSET_VAR b $(true)')).toBe('["b"]\n');
  });

  it('joins empty quotes onto adjacent text', async () => {
    const { run } = createTestShell();
    expect(await run(`argv a"" ""b`)).toBe('["a","b"]\n');
  });

  it('grep -c "" counts every line', async () => {
    const { run } = createTestShell();
    expect(await run('grep -c "" a.txt')).toBe('3\n');
    expect(await run(`grep -c '' a.txt`)).toBe('3\n');
    expect(await run('grep -c -- "" a.txt')).toBe('3\n');
  });

  it('grep with no pattern still says so', async () => {
    const { run } = createTestShell();
    expect(await run('grep -c 2>&1')).toContain('missing pattern');
  });

  it('printf reuses its format for every argument, empty ones included', async () => {
    const { run } = createTestShell();
    expect(await run(`printf '%s|' "" a ''`)).toBe('|a||');
    expect(await run(`printf '%s\\n' a b c`)).toBe('a\nb\nc\n');
    expect(await run(`printf 'plain\\n' extra`)).toBe('plain\n');
  });
});
