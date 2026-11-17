import { describe, it, expect, beforeAll } from 'vitest';
import { VFS } from '@lifo-sh/core';
import type { CommandContext } from '@lifo-sh/core';
import python from '../src/index.js';
import pip from '../src/pip.js';

type Ctx = CommandContext & { out: string; err: string };

function makeCtx(vfs: VFS, args: string[], opts: { cwd?: string; stdin?: string } = {}): Ctx {
  const ctx = {
    args,
    env: { HOME: '/home/user', USER: 'user', GREETING: 'hi' },
    cwd: opts.cwd ?? '/home/user',
    vfs,
    stdout: { write(t: string) { ctx.out += t; } },
    stderr: { write(t: string) { ctx.err += t; } },
    signal: new AbortController().signal,
    stdin:
      opts.stdin === undefined
        ? undefined
        : { read: async () => null, readAll: async () => opts.stdin! },
    out: '',
    err: '',
  } as Ctx;
  return ctx;
}

describe('python', () => {
  const vfs = new VFS();
  vfs.mkdir('/home/user', { recursive: true });
  vfs.mkdir('/tmp', { recursive: true });

  beforeAll(async () => {
    // Load the interpreter once (the first run downloads nothing in Node; it reads the npm package).
    await python(makeCtx(vfs, ['-c', 'pass']));
  });

  it('runs -c and streams stdout', async () => {
    const ctx = makeCtx(vfs, ['-c', 'print(2 ** 100); import sys; print(sys.argv)', 'a']);
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toBe("1267650600228229401496703205376\n['-c', 'a']\n");
  });

  it('prints the version', async () => {
    const ctx = makeCtx(vfs, ['--version']);
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toMatch(/^Python 3\.\d+\.\d+\n$/);
  });

  it('runs a script that reads and writes the box files', async () => {
    vfs.mkdir('/home/user/proj', { recursive: true });
    vfs.writeFile('/home/user/proj/data.csv', 'name,score\nada,3\nlin,5\n');
    vfs.writeFile('/home/user/proj/old.txt', 'delete me');
    vfs.writeFile('/home/user/proj/helper.py', 'def total(rows): return sum(int(r["score"]) for r in rows)\n');
    vfs.writeFile(
      '/home/user/proj/report.py',
      [
        'import csv, os, sys',
        'from helper import total',
        'rows = list(csv.DictReader(open("data.csv")))',
        'os.makedirs("out", exist_ok=True)',
        'open("out/total.txt", "w").write(f"{total(rows)} from {sys.argv[1]}\\n")',
        'os.remove("old.txt")',
        'print(os.getcwd(), os.environ["GREETING"])',
      ].join('\n'),
    );
    const ctx = makeCtx(vfs, ['report.py', 'cli'], { cwd: '/home/user/proj' });
    expect(await python(ctx)).toBe(0);
    expect(ctx.err).toBe('');
    expect(ctx.out).toBe('/home/user/proj hi\n');
    expect(vfs.readFileString('/home/user/proj/out/total.txt')).toBe('8 from cli\n');
    expect(vfs.exists('/home/user/proj/old.txt')).toBe(false);
    expect(vfs.exists('/home/user/proj/__pycache__')).toBe(false);
  });

  it('sees edits and deletions made in the box between runs', async () => {
    vfs.writeFile('/home/user/proj/helper.py', 'def total(rows): return 42\n');
    const ctx = makeCtx(vfs, ['-c', 'from helper import total; import os; print(total([]), os.path.exists("out/total.txt"))'], {
      cwd: '/home/user/proj',
    });
    vfs.unlink('/home/user/proj/out/total.txt');
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toBe('42 False\n');
  });

  it('reads piped stdin', async () => {
    const ctx = makeCtx(vfs, ['-c', 'import sys, json; d = json.load(sys.stdin); print(d["a"] + 1)'], { stdin: '{"a": 41}' });
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toBe('42\n');
  });

  it('runs a program given on stdin', async () => {
    const ctx = makeCtx(vfs, [], { stdin: 'import statistics\nprint(statistics.mean([1, 2, 3, 6]))\n' });
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toBe('3\n');
  });

  it('returns exit codes from sys.exit and errors', async () => {
    expect(await python(makeCtx(vfs, ['-c', 'import sys; sys.exit(3)']))).toBe(3);
    expect(await python(makeCtx(vfs, ['-c', 'import sys; sys.exit()']))).toBe(0);
    const msg = makeCtx(vfs, ['-c', 'import sys; sys.exit("bad input")']);
    expect(await python(msg)).toBe(1);
    expect(msg.err).toBe('bad input\n');
    const err = makeCtx(vfs, ['-c', 'raise ValueError("nope")']);
    expect(await python(err)).toBe(1);
    expect(err.err).toContain('ValueError: nope');
    expect(err.err).not.toContain('_lifo_run');
  });

  it('imports stdlib modules', async () => {
    const ctx = makeCtx(vfs, ['-c', 'import sqlite3, hashlib, datetime; c = sqlite3.connect(":memory:"); print(c.execute("select 6*7").fetchone()[0], hashlib.sha1(b"x").hexdigest()[:8])']);
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toBe('42 11f6ad8e\n');
  });

  it('shows only the script in a traceback', async () => {
    vfs.writeFile('/home/user/boom.py', 'def f():\n    raise KeyError("k")\nf()\n');
    const ctx = makeCtx(vfs, ['boom.py']);
    expect(await python(ctx)).toBe(1);
    expect(ctx.err).toContain('File "/home/user/boom.py", line 3');
    expect(ctx.err).not.toMatch(/runpy|<exec>/);
    vfs.writeFile('/home/user/bad.py', 'print("x\n');
    const bad = makeCtx(vfs, ['bad.py']);
    expect(await python(bad)).toBe(1);
    expect(bad.err).toContain('SyntaxError');
    expect(bad.err).not.toMatch(/runpy/);
  });

  it('reports a missing file', async () => {
    const ctx = makeCtx(vfs, ['nope.py']);
    expect(await python(ctx)).toBe(2);
    expect(ctx.err).toContain("can't open file");
  });

  it('pip --version answers', async () => {
    const ctx = makeCtx(vfs, ['--version']);
    expect(await pip(ctx)).toBe(0);
    expect(ctx.out).toContain('micropip');
  });
});

// Downloads from PyPI: LIFO_NET=1 pnpm test
describe.runIf(process.env.LIFO_NET)('pip (network)', () => {
  const vfs = new VFS();
  vfs.mkdir('/home/user', { recursive: true });

  it('installs a pure-Python package and imports it', async () => {
    const ctx = makeCtx(vfs, ['install', 'six']);
    expect(await pip(ctx)).toBe(0);
    expect(ctx.out).toMatch(/Successfully installed .*six-/);
    const run = makeCtx(vfs, ['-c', 'import six; print(six.PY3)']);
    expect(await python(run)).toBe(0);
    expect(run.out).toBe('True\n');
    const list = makeCtx(vfs, ['-m', 'pip', 'list']);
    expect(await python(list)).toBe(0);
    expect(list.out).toContain('six');
  });

  it('loads a Pyodide-built package on import', async () => {
    const ctx = makeCtx(vfs, ['-c', 'import numpy as np; print(int(np.arange(10).sum()))']);
    expect(await python(ctx)).toBe(0);
    expect(ctx.out).toBe('45\n');
  });
});
