/**
 * The Python runtime behind `python` and `pip`: one Pyodide interpreter per box (per VFS), loaded
 * the first time either command runs, plus the bridge between the box's files and Pyodide's own
 * in-memory filesystem.
 *
 * Files: before every run the working trees (HOME, /tmp, the cwd and the script's folder) are
 * copied from the Lifo VFS into Pyodide's filesystem at the same paths, skipping files that haven't
 * changed since the last run. After the run, files Python created or changed are written back to
 * the VFS and files it deleted are deleted there too, so `python make_report.py && cat report.txt`
 * works. node_modules, .git and files over 32 MB are not copied.
 */

import type { CommandContext, VFS } from '@lifo-sh/core';

/** Pyodide release this package is built and tested against. */
export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '__pycache__', '.cache']);
const MAX_FILE = 32 * 1024 * 1024;

// The parts of Pyodide (and its Emscripten FS) used here.
interface EmFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number; mtime: Date | number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
  utime(path: string, atime: number, mtime: number): void;
}
interface PyProxyLike {
  toJs?(): unknown;
  destroy?(): void;
}
export interface Pyodide {
  FS: EmFS;
  version: string;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(names: string | string[], opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  loadPackagesFromImports(code: string, opts?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  setStdout(opts: { write: (buf: Uint8Array) => number; isatty?: boolean }): void;
  setStderr(opts: { write: (buf: Uint8Array) => number; isatty?: boolean }): void;
  setStdin(opts: { read: (buf: Uint8Array) => number; isatty?: boolean }): void;
  setInterruptBuffer?(buf: Int32Array | Uint8Array): void;
  registerJsModule(name: string, module: object): void;
  globals: { set(name: string, value: unknown): void; get(name: string): unknown };
  toPy(value: unknown): PyProxyLike;
}

/** Where a run's output goes and where its input comes from; swapped in per run. */
interface RunIO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Bytes of piped stdin not yet read by Python. */
  stdin: Uint8Array;
  stdinPos: number;
  /** Line reader for input() on an interactive terminal (needs JSPI; see input below). */
  readLine: (() => Promise<string | null>) | null;
}

export interface PythonBox {
  py: Pyodide;
  /** Serializes runs: the interpreter, cwd, env and std streams are process-wide. */
  lock: Promise<unknown>;
  io: RunIO;
  /** VFS mtime and size of every file copied in, keyed by path, to skip unchanged ones. */
  synced: Map<string, { mtime: number; size: number }>;
  interrupt: Int32Array | null;
}

const boxes = new WeakMap<VFS, Promise<PythonBox>>();

function isNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof (globalThis as { window?: unknown }).window === 'undefined' && !!p?.versions?.node;
}

type Loader = (opts: object) => Promise<Pyodide>;

/** workerd (Cloudflare's runtime, where Lifo Cloud boxes run). */
function isWorkerd(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return !!nav?.userAgent?.includes('Cloudflare-Workers');
}

/**
 * A WebAssembly namespace whose async entry points compile synchronously. In workerd an async
 * compile resolves outside the request (which is then cancelled as hung) and
 * instantiateStreaming doesn't exist; on its single thread a synchronous compile blocks no more
 * than an async one would.
 */
function syncWebAssembly(): typeof WebAssembly {
  const W = WebAssembly;
  const mod = (src: WebAssembly.Module | BufferSource) => (src instanceof W.Module ? src : new W.Module(src));
  const instantiate = async (src: WebAssembly.Module | BufferSource, imports?: WebAssembly.Imports) => {
    const module = mod(src);
    const instance = new W.Instance(module, imports);
    return src instanceof W.Module ? instance : { module, instance };
  };
  return Object.assign(Object.create(W), {
    compile: async (bytes: BufferSource) => mod(bytes),
    instantiate,
    compileStreaming: async (res: Response | PromiseLike<Response>) => mod(await (await res).arrayBuffer()),
    instantiateStreaming: async (res: Response | PromiseLike<Response>, imports?: WebAssembly.Imports) => instantiate(await (await res).arrayBuffer(), imports),
  }) as typeof WebAssembly;
}

/**
 * fetch for Pyodide in workerd, which refuses the `integrity` option Pyodide passes for packages
 * ("Subrequest integrity checking is not implemented"): the check is done here instead.
 */
export async function checkedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const integrity = init?.integrity;
  if (!integrity) return fetch(input, init);
  const { integrity: _dropped, ...rest } = init;
  const res = await fetch(input, rest);
  if (!res.ok) return res;
  const body = await res.arrayBuffer();
  const algos: Record<string, string> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  const wanted = integrity.trim().split(/\s+/).map((v) => v.split('-')).filter(([a]) => algos[a]);
  if (wanted.length) {
    let ok = false;
    for (const [algo, ...hash] of wanted) {
      const digest = new Uint8Array(await crypto.subtle.digest(algos[algo], body));
      let bin = '';
      for (const b of digest) bin += String.fromCharCode(b);
      if (btoa(bin) === hash.join('-').split('?')[0]) ok = true;
    }
    if (!ok) throw new TypeError(`Failed to fetch ${String(input)}: it doesn't match its integrity hash`);
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`python: ${url} answered ${res.status}`);
  return res.text();
}

/**
 * Load Pyodide where a module can't be import()ed from a URL (workerd): fetch its two scripts and
 * evaluate them as functions. They are ES modules written for browsers and Node, so three things
 * are adjusted, all tied to PYODIDE_VERSION:
 *  - their `export`s become return values, and `import.meta.url` the script's URL;
 *  - `process` is hidden, because workerd's Node compatibility would send Pyodide down its Node
 *    path (node:fs, require of an https URL); `location` gets the index URL;
 *  - WebAssembly is the synchronous one above, and fetch checks `integrity` itself.
 */
export async function loadFromSource(base: string): Promise<{ loadPyodide: Loader; indexURL: string }> {
  const [loaderSrc, asmSrc] = await Promise.all([fetchText(`${base}pyodide.mjs`), fetchText(`${base}pyodide.asm.mjs`)]);
  const wasm = syncWebAssembly();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
  const fail = (what: string) => new Error(`python: Pyodide ${PYODIDE_VERSION} doesn't look as expected (${what}); this loader needs updating for it`);

  const exportRe = /export\s*\{([^}]*)\}\s*;?/;
  const exported = exportRe.exec(loaderSrc)?.[1].split(',').map((e) => e.trim().split(/\s+as\s+/)).find(([, as]) => as === 'loadPyodide');
  if (!exported) throw fail('pyodide.mjs exports');
  const loaderBody = `${loaderSrc.replace(exportRe, '')}\nreturn ${exported[0]};`;
  const loadPyodide = (await new AsyncFunction('process', 'location', 'WebAssembly', 'fetch', loaderBody)(undefined, base, wasm, checkedFetch)) as Loader;

  const NODE_CHECK = 'globalThis.process?.versions?.node';
  const EXPORT_DEFAULT = /export\s+default\s+(\w+)\s*;?\s*$/;
  const factory = EXPORT_DEFAULT.exec(asmSrc)?.[1];
  if (!factory || !asmSrc.includes(NODE_CHECK)) throw fail('pyodide.asm.mjs');
  const asmBody = `${asmSrc.replace(EXPORT_DEFAULT, '').replaceAll(NODE_CHECK, '(void 0)').replaceAll('import.meta.url', JSON.stringify(`${base}pyodide.asm.mjs`))}\nreturn ${factory};`;
  const createPyodideModule = await new AsyncFunction('process', 'location', 'WebAssembly', 'fetch', asmBody)(undefined, base, wasm, checkedFetch);

  return { loadPyodide: (opts) => loadPyodide({ ...opts, createPyodideModule }), indexURL: base };
}

async function importPyodide(indexURL: string | undefined): Promise<{ loadPyodide: Loader; indexURL: string }> {
  const base = indexURL ?? PYODIDE_CDN;
  if (isWorkerd()) return loadFromSource(base);
  if (isNode() && !indexURL) {
    // The npm package, found next to this file. Variable specifiers plus ignore hints keep
    // bundlers of the browser build from trying to resolve either.
    const nodeModule = 'node:module';
    const spec = 'pyodide';
    const { createRequire } = await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ nodeModule);
    const main: string = createRequire(import.meta.url).resolve(spec);
    const dir = main.slice(0, main.lastIndexOf('/') + 1);
    const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ `${dir}pyodide.mjs`);
    return { loadPyodide: mod.loadPyodide, indexURL: dir };
  }
  const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ `${base}pyodide.mjs`);
  return { loadPyodide: mod.loadPyodide, indexURL: base };
}

// Python-side helpers, defined once per interpreter.
const PRELUDE = String.raw`
import sys, os, io, builtins, traceback, runpy, code
sys.dont_write_bytecode = True
import _lifo_io

try:
    sys.stdout.reconfigure(line_buffering=True, write_through=True)
    sys.stderr.reconfigure(line_buffering=True, write_through=True)
except Exception:
    pass

_lifo_builtin_input = builtins.input

def _lifo_input(prompt=''):
    if not _lifo_io.interactive:
        return _lifo_builtin_input(prompt)
    if prompt:
        sys.stdout.write(str(prompt)); sys.stdout.flush()
    try:
        from pyodide.ffi import run_sync, can_run_sync
        ok = can_run_sync()
    except Exception:
        ok = False
    if not ok:
        raise EOFError('input() from the terminal needs a browser with JavaScript Promise Integration (JSPI); pipe input instead: echo 42 | python3 script.py')
    line = run_sync(_lifo_io.readLine())
    if line is None:
        raise EOFError
    return line[:-1] if line.endswith('\n') else line

builtins.input = _lifo_input

def _lifo_exit_code(e):
    c = e.code
    if c is None:
        return 0
    if isinstance(c, int):
        return c & 0xFF
    print(c, file=sys.stderr)
    return 1

def _lifo_forget_modules(roots):
    # Modules imported from the box's files are dropped after a run, so an edited module is re-read.
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, '__file__', None) or ''
        if any(f.startswith(r.rstrip('/') + '/') for r in roots):
            del sys.modules[name]

def _lifo_prepare(cwd, env, argv, path0):
    os.chdir(cwd)
    os.environ.clear()
    os.environ.update(env)
    sys.argv = list(argv)
    while sys.path and sys.path[0] in _lifo_prepare.added:
        sys.path.pop(0)
    sys.path.insert(0, path0)
    _lifo_prepare.added = {path0}
_lifo_prepare.added = set()

def _lifo_run(mode, target, roots):
    try:
        if mode == 'c':
            exec(compile(target, '<string>', 'exec'), {'__name__': '__main__', '__builtins__': builtins})
        elif mode == 'file':
            runpy.run_path(target, run_name='__main__')
        elif mode == 'module':
            runpy.run_module(target, run_name='__main__', alter_sys=True)
        return 0
    except SystemExit as e:
        return _lifo_exit_code(e)
    except KeyboardInterrupt:
        print('KeyboardInterrupt', file=sys.stderr)
        return 130
    except BaseException:
        t, v, tb = sys.exc_info()
        # Drop this helper's and runpy's frames from the traceback, as CPython's own launcher does.
        while tb is not None and (tb.tb_frame.f_code.co_filename in ('<exec>', runpy.__file__) or tb.tb_frame.f_code.co_filename.startswith('<frozen runpy')):
            tb = tb.tb_next
        traceback.print_exception(t, v, tb)
        return 1
    finally:
        try:
            sys.stdout.flush(); sys.stderr.flush()
        except Exception:
            pass
        _lifo_forget_modules(roots)

class _LifoConsole(code.InteractiveConsole):
    def push_line(self, line):
        try:
            return 1 if self.push(line) else 0
        except SystemExit as e:
            return 1000 + _lifo_exit_code(e)

def _lifo_console():
    c = _LifoConsole({'__name__': '__main__', '__builtins__': builtins})
    return c
`;

async function createBox(ctx: CommandContext): Promise<PythonBox> {
  const { loadPyodide, indexURL } = await importPyodide(ctx.env.PYODIDE_INDEX_URL || undefined);
  const io: RunIO = { out: () => {}, err: () => {}, stdin: new Uint8Array(0), stdinPos: 0, readLine: null };
  const py = await loadPyodide({ indexURL, fullStdLib: false });
  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  py.setStdout({ write: (b) => (io.out(outDec.decode(b, { stream: true })), b.length), isatty: false });
  py.setStderr({ write: (b) => (io.err(errDec.decode(b, { stream: true })), b.length), isatty: false });
  py.setStdin({
    read: (buf) => {
      const n = Math.min(buf.length, io.stdin.length - io.stdinPos);
      buf.set(io.stdin.subarray(io.stdinPos, io.stdinPos + n));
      io.stdinPos += n;
      return n;
    },
    isatty: false,
  });
  const ioModule = {
    interactive: false,
    readLine: () => (io.readLine ? io.readLine() : Promise.resolve(null)),
  };
  py.registerJsModule('_lifo_io', ioModule);
  let interrupt: Int32Array | null = null;
  if (typeof SharedArrayBuffer !== 'undefined' && py.setInterruptBuffer) {
    try {
      interrupt = new Int32Array(new SharedArrayBuffer(4));
      py.setInterruptBuffer(interrupt);
    } catch {
      interrupt = null;
    }
  }
  py.runPython(PRELUDE);
  const box: PythonBox = { py, lock: Promise.resolve(), io, synced: new Map(), interrupt };
  (box as PythonBox & { ioModule: typeof ioModule }).ioModule = ioModule;
  return box;
}

/** The box's interpreter, loading Pyodide the first time (a few MB, cached by the browser after). */
export function getPython(ctx: CommandContext): Promise<PythonBox> {
  let p = boxes.get(ctx.vfs);
  if (!p) {
    p = createBox(ctx);
    boxes.set(ctx.vfs, p);
    p.catch(() => boxes.delete(ctx.vfs));
  }
  return p;
}

export function isLoaded(vfs: VFS): boolean {
  return boxes.has(vfs);
}

export function setInteractive(box: PythonBox, on: boolean): void {
  (box as PythonBox & { ioModule: { interactive: boolean } }).ioModule.interactive = on;
}

/** Run `fn` with the interpreter to itself (one run at a time per box). */
export async function withPython<T>(box: PythonBox, fn: () => Promise<T>): Promise<T> {
  const prev = box.lock;
  let release!: () => void;
  box.lock = new Promise<void>((r) => (release = r));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── Files ───

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function mtimeOf(t: Date | number): number {
  return typeof t === 'number' ? t : t.getTime();
}

/** The folders a run can see: HOME, /tmp, the cwd and any extra (the script's folder), deduped. */
export function syncRoots(ctx: CommandContext, extra: string[] = []): string[] {
  const candidates = [ctx.env.HOME || '/home/user', '/tmp', ctx.cwd, ...extra];
  const ok = candidates.filter((p) => {
    if (!p || p === '/' || /^\/(proc|dev|sys)(\/|$)/.test(p)) return false;
    try {
      return ctx.vfs.stat(p).type === 'directory';
    } catch {
      return false;
    }
  });
  const unique = [...new Set(ok.map((p) => p.replace(/\/+$/, '') || '/'))].sort((a, b) => a.length - b.length);
  return unique.filter((p, i) => !unique.slice(0, i).some((r) => p.startsWith(r + '/')));
}

/** Pyodide's view after sync-in: path -> mtime, so sync-out can tell what Python changed. */
export type FsBaseline = Map<string, number>;

/** Copy the roots from the VFS into Pyodide's filesystem. */
export function syncIn(box: PythonBox, vfs: VFS, roots: string[]): FsBaseline {
  const FS = box.py.FS;
  const baseline: FsBaseline = new Map();
  const seen = new Set<string>();

  const walk = (dir: string) => {
    seen.add(dir);
    try {
      FS.mkdirTree(dir);
    } catch {
      /* exists */
    }
    baseline.set(dir, -1);
    let entries;
    try {
      entries = vfs.readdirStat(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.type === 'directory') {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (e.type !== 'file' || e.size > MAX_FILE) continue;
      seen.add(p);
      const prev = box.synced.get(p);
      let current: { mtime: number; size: number } | null = null;
      try {
        const st = FS.stat(p);
        current = { mtime: mtimeOf(st.mtime), size: st.size };
      } catch {
        /* not there yet */
      }
      const unchanged = prev && current && prev.mtime === e.mtime && prev.size === e.size && current.mtime === e.mtime && current.size === e.size;
      if (!unchanged) {
        try {
          FS.writeFile(p, vfs.readFile(p));
          FS.utime(p, e.mtime, e.mtime);
        } catch {
          continue;
        }
        box.synced.set(p, { mtime: e.mtime, size: e.size });
      }
      baseline.set(p, e.mtime);
    }
  };
  for (const r of roots) walk(r);

  // Files deleted from the box since the last run disappear from Python's view too.
  const prune = (dir: string) => {
    let names: string[];
    try {
      names = FS.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === '.' || n === '..') continue;
      const p = join(dir, n);
      let st;
      try {
        st = FS.stat(p);
      } catch {
        continue;
      }
      if (FS.isDir(st.mode)) {
        if (SKIP_DIRS.has(n)) continue;
        if (!seen.has(p)) removeTree(FS, p);
        else prune(p);
      } else if (!seen.has(p) && !(st.size > MAX_FILE)) {
        try {
          FS.unlink(p);
        } catch {
          /* ignore */
        }
        box.synced.delete(p);
      }
    }
  };
  for (const r of roots) prune(r);
  return baseline;
}

function removeTree(FS: EmFS, dir: string): void {
  for (const n of FS.readdir(dir)) {
    if (n === '.' || n === '..') continue;
    const p = join(dir, n);
    if (FS.isDir(FS.stat(p).mode)) removeTree(FS, p);
    else FS.unlink(p);
  }
  FS.rmdir(dir);
}

/** Write what Python created, changed or deleted under the roots back to the VFS. */
export function syncOut(box: PythonBox, vfs: VFS, roots: string[], baseline: FsBaseline): void {
  const FS = box.py.FS;
  const present = new Set<string>();
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = FS.readdir(dir);
    } catch {
      return;
    }
    present.add(dir);
    if (!baseline.has(dir)) {
      try {
        vfs.mkdir(dir, { recursive: true });
      } catch {
        /* exists */
      }
    }
    for (const n of names) {
      if (n === '.' || n === '..') continue;
      const p = join(dir, n);
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) {
        if (!SKIP_DIRS.has(n)) walk(p);
        continue;
      }
      if (!FS.isFile(st.mode)) continue;
      present.add(p);
      const before = baseline.get(p);
      const m = mtimeOf(st.mtime);
      if (before !== undefined && before === m) continue;
      if (before === undefined && st.size > MAX_FILE) continue;
      try {
        vfs.writeFile(p, FS.readFile(p));
        const vs = vfs.stat(p);
        // Python's copy now matches the box's; note it so the next sync-in skips it.
        FS.utime(p, vs.mtime, vs.mtime);
        box.synced.set(p, { mtime: vs.mtime, size: vs.size });
      } catch {
        /* unwritable path in the box */
      }
    }
  };
  for (const r of roots) walk(r);

  // Deleted by Python: remove from the box (files first, then now-empty folders, deepest first).
  const gone = [...baseline.keys()].filter((p) => !present.has(p));
  for (const p of gone.filter((p) => baseline.get(p) !== -1)) {
    try {
      vfs.unlink(p);
    } catch {
      /* already gone */
    }
    box.synced.delete(p);
  }
  for (const p of gone.filter((p) => baseline.get(p) === -1).sort((a, b) => b.length - a.length)) {
    try {
      vfs.rmdirRecursive(p);
    } catch {
      /* already gone */
    }
  }
}

/** Point the interpreter's std streams at this run. */
export function bindIO(box: PythonBox, ctx: CommandContext, stdin: string, readLine: RunIO['readLine']): void {
  box.io.out = (s) => s && ctx.stdout.write(s);
  box.io.err = (s) => s && ctx.stderr.write(s);
  box.io.stdin = new TextEncoder().encode(stdin);
  box.io.stdinPos = 0;
  box.io.readLine = readLine;
}

export function unbindIO(box: PythonBox): void {
  box.io.out = () => {};
  box.io.err = () => {};
  box.io.stdin = new Uint8Array(0);
  box.io.readLine = null;
}

/** Load Pyodide-built packages (numpy, pandas, …) that `source` imports, quietly. */
export async function loadImports(box: PythonBox, source: string, err: (s: string) => void): Promise<void> {
  try {
    await box.py.loadPackagesFromImports(source, {
      messageCallback: (m) => {
        if (/^Loading /.test(m)) err(`${m}\n`);
      },
      errorCallback: () => {},
    });
  } catch {
    /* the import will fail in Python with a normal ImportError */
  }
}

export function pyStr(s: string): string {
  return JSON.stringify(s);
}
