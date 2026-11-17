/**
 * lifo-pkg-python: `python` / `python3` for Lifo. CPython 3 compiled to WebAssembly (Pyodide),
 * running in the same JS thread as the box.
 *
 *   python3 -c "print(2 ** 100)"
 *   python3 script.py arg1 arg2        files are the box's files (see runtime.ts)
 *   echo '{"a": 1}' | python3 -c "import json, sys; print(json.load(sys.stdin))"
 *   python3 -m pip install <package>   pure-Python wheels from PyPI, via micropip
 *   python3                            an interactive prompt on a terminal
 *
 * Packages Pyodide builds (numpy, pandas, …) are loaded automatically when a script imports them.
 * The interpreter loads on first use (about 6 MB, cached by the browser) and stays loaded for the
 * box, so later runs start instantly.
 */

import type { CommandContext } from '@lifo-sh/core';
import {
  bindIO,
  getPython,
  isLoaded,
  loadImports,
  setInteractive,
  syncIn,
  syncOut,
  syncRoots,
  unbindIO,
  withPython,
  type PythonBox,
} from './runtime.js';
import { pipMain } from './pip.js';

export { PYODIDE_VERSION, PYODIDE_CDN } from './runtime.js';
export { default as pip } from './pip.js';

const USAGE = `usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...
  -c cmd   run the program passed in as a string
  -m mod   run a library module as a script (python3 -m pip install <pkg>)
  -V       print the Python version
  file     run the program in a file; - reads the program from stdin
  With no arguments on a terminal, starts the interactive prompt.
Python here is CPython on WebAssembly (Pyodide). Pure-Python packages install with pip;
packages Pyodide builds (numpy, pandas, …) load when imported. No native extensions.
`;

/** True when stdin is the terminal itself (not a pipe, a file or captured input). */
function isTty(ctx: CommandContext): boolean {
  const s = ctx.stdin as unknown as { feed?: unknown; closed?: boolean } | undefined;
  return !!ctx.setRawMode && !!s && typeof s.feed === 'function' && s.closed === false;
}

async function load(ctx: CommandContext): Promise<PythonBox> {
  // A one-line notice on a terminal while the interpreter downloads; nothing in captured output.
  const notice = !isLoaded(ctx.vfs) && !!ctx.setRawMode;
  if (notice) ctx.stderr.write('\x1b[2mLoading Python (first run in this box)…\x1b[0m');
  try {
    return await getPython(ctx);
  } finally {
    if (notice) ctx.stderr.write('\r\x1b[2K');
  }
}

type Mode = { kind: 'c' | 'file' | 'module'; target: string; argv: string[]; path0: string; source: string };

function resolvePath(cwd: string, p: string): string {
  if (p.startsWith('/')) return p;
  const parts = `${cwd}/${p}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

async function runProgram(ctx: CommandContext, mode: Mode, stdin: string): Promise<number> {
  const box = await load(ctx);
  return withPython(box, async () => {
    const tty = isTty(ctx);
    const extra = mode.kind === 'file' ? [mode.path0] : [];
    const roots = syncRoots(ctx, extra);
    const baseline = syncIn(box, ctx.vfs, roots);
    bindIO(box, ctx, stdin, tty && ctx.stdin ? () => ctx.stdin!.read() : null);
    setInteractive(box, tty);
    const onAbort = () => {
      if (box.interrupt) box.interrupt[0] = 2; // SIGINT, seen by Python at its next check
    };
    ctx.signal.addEventListener('abort', onAbort);
    try {
      if (mode.source) await loadImports(box, mode.source, (s) => ctx.stderr.write(s));
      const py = box.py;
      py.globals.set('_lifo_args', py.toPy([ctx.cwd, { ...ctx.env }, mode.argv, mode.path0]));
      py.globals.set('_lifo_target', py.toPy([mode.kind, mode.target, roots]));
      const code = (await py.runPythonAsync('_lifo_prepare(*_lifo_args); _lifo_run(*_lifo_target)')) as number;
      if (ctx.signal.aborted) return 130;
      return typeof code === 'number' ? code : 0;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (box.interrupt) box.interrupt[0] = 0;
      setInteractive(box, false);
      unbindIO(box);
      syncOut(box, ctx.vfs, roots, baseline);
    }
  });
}

async function repl(ctx: CommandContext): Promise<number> {
  const box = await load(ctx);
  const py = box.py;
  const version = String(py.runPython('import sys; sys.version.split()[0]'));
  ctx.stdout.write(`Python ${version} (Pyodide ${py.version}) on lifo\nType "help", "copyright", "credits" or "license" for more information.\n`);
  return withPython(box, async () => {
    const roots = syncRoots(ctx);
    py.globals.set('_lifo_args', py.toPy([ctx.cwd, { ...ctx.env }, [''], '']));
    py.runPython('_lifo_prepare(*_lifo_args); _lifo_repl = _lifo_console()');
    let more = false;
    try {
      for (;;) {
        ctx.stdout.write(more ? '... ' : '>>> ');
        const line = await ctx.stdin!.read();
        if (line === null || ctx.signal.aborted) {
          ctx.stdout.write('\n');
          return ctx.signal.aborted ? 130 : 0;
        }
        const text = line.replace(/\r?\n$/, '');
        // Each line sees the box's current files and leaves its changes there.
        const baseline = syncIn(box, ctx.vfs, roots);
        bindIO(box, ctx, '', () => ctx.stdin!.read());
        setInteractive(box, true);
        try {
          await loadImports(box, text, (s) => ctx.stderr.write(s));
          py.globals.set('_lifo_line', text);
          const r = Number(await py.runPythonAsync('_lifo_repl.push_line(_lifo_line)'));
          if (r >= 1000) return r - 1000;
          more = r === 1;
        } finally {
          setInteractive(box, false);
          unbindIO(box);
          syncOut(box, ctx.vfs, roots, baseline);
        }
      }
    } finally {
      py.runPython('_lifo_repl = None');
    }
  });
}

export default async function python(ctx: CommandContext): Promise<number> {
  const args = [...ctx.args];
  // Flags that change nothing here: unbuffered (output is never buffered), no .pyc files, isolated, quiet.
  while (args.length && /^-[uBIEqsSOW]+$/.test(args[0])) args.shift();

  const a0 = args[0];
  if (a0 === '-h' || a0 === '--help') {
    ctx.stdout.write(USAGE);
    return 0;
  }
  if (a0 === '-V' || a0 === '--version') {
    const box = await load(ctx);
    ctx.stdout.write(`Python ${String(box.py.runPython('import sys; sys.version.split()[0]'))}\n`);
    return 0;
  }
  try {
    if (a0 === '-c') {
      if (args.length < 2) {
        ctx.stderr.write('Argument expected for the -c option\n');
        return 2;
      }
      const stdin = !isTty(ctx) && ctx.stdin ? await ctx.stdin.readAll() : '';
      return await runProgram(ctx, { kind: 'c', target: args[1], argv: ['-c', ...args.slice(2)], path0: '', source: args[1] }, stdin);
    }
    if (a0 === '-m') {
      const mod = args[1];
      if (!mod) {
        ctx.stderr.write('Argument expected for the -m option\n');
        return 2;
      }
      if (mod === 'pip') return await pipMain(ctx, args.slice(2));
      const stdin = !isTty(ctx) && ctx.stdin ? await ctx.stdin.readAll() : '';
      return await runProgram(ctx, { kind: 'module', target: mod, argv: [mod, ...args.slice(2)], path0: ctx.cwd, source: `import ${mod}` }, stdin);
    }
    if (a0 === undefined || a0 === '-') {
      if (a0 === undefined && isTty(ctx)) return await repl(ctx);
      const program = ctx.stdin ? await ctx.stdin.readAll() : '';
      return await runProgram(ctx, { kind: 'c', target: program, argv: ['-', ...args.slice(1)], path0: '', source: program }, '');
    }
    if (a0.startsWith('-')) {
      ctx.stderr.write(`Unknown option: ${a0}\n${USAGE}`);
      return 2;
    }
    const file = resolvePath(ctx.cwd, a0);
    let source: string;
    try {
      source = ctx.vfs.readFileString(file);
    } catch {
      ctx.stderr.write(`python3: can't open file '${file}': [Errno 2] No such file or directory\n`);
      return 2;
    }
    const stdin = !isTty(ctx) && ctx.stdin ? await ctx.stdin.readAll() : '';
    const dir = file.slice(0, file.lastIndexOf('/')) || '/';
    return await runProgram(ctx, { kind: 'file', target: file, argv: [a0, ...args.slice(1)], path0: dir, source }, stdin);
  } catch (e) {
    ctx.stderr.write(`python3: ${(e as Error).message}\n`);
    return 1;
  }
}
