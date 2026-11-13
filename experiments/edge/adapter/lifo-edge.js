// lifo-edge: a Lifo box on hosts that forbid code generation (Cloudflare Workers, Vercel Edge,
// any V8 isolate started with code generation off). Prototype; see cloud/docs/edge-runtimes.md.
//
//   import { createEdgeSandbox } from './lifo-edge.js';
//   const box = await createEdgeSandbox({ quickjs });   // quickjs is optional
//   await box.commands.run('echo hi | tr a-z A-Z');
//
// What it adds on top of Sandbox.create():
//  - hostCapabilities(): what this host allows (eval, runtime wasm compilation, CompressionStream).
//  - `node` that works where eval doesn't: single files, -e, CommonJS require of the box's own
//    files, fs (sync), path and process, run on QuickJS (a JS interpreter compiled to wasm and
//    imported as a module at build time, which these hosts allow). Without QuickJS, `node` explains
//    why it can't run instead of failing with EvalError.
//  - python / pip explain themselves where wasm can't be compiled at run time (Pyodide needs it).
//  - gzip for hosts without CompressionStream (tar -z, snapshots), on fflate.

import { Sandbox } from '@lifo-sh/core';
import { Gzip, Gunzip } from 'fflate';

const WASM_EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** What this host lets Lifo do. Cheap; probe once per isolate. */
export function hostCapabilities() {
  let codegen = true;
  try {
    new Function('return 1')();
  } catch {
    codegen = false;
  }
  let wasmCompile = true;
  try {
    new WebAssembly.Module(WASM_EMPTY);
  } catch {
    wasmCompile = false;
  }
  return {
    codegen,
    wasmCompile,
    compressionStream: typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined',
  };
}

/** CompressionStream / DecompressionStream ('gzip') on fflate, for hosts that don't have them. */
export function installGzipFallback({ force = false } = {}) {
  if (!force && typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined') return false;
  const make = (Codec) =>
    class {
      constructor(format) {
        if (format !== 'gzip') throw new TypeError(`lifo-edge: only gzip is supported, not ${format}`);
        let controller;
        const codec = new Codec((chunk, final) => {
          if (chunk.length) controller.enqueue(chunk);
          if (final) controller.close();
        });
        this.readable = new ReadableStream({ start: (c) => void (controller = c) });
        this.writable = new WritableStream({
          write: (chunk) => codec.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)),
          close: () => codec.push(new Uint8Array(0), true),
        });
      }
    };
  globalThis.CompressionStream = make(Gzip);
  globalThis.DecompressionStream = make(Gunzip);
  return true;
}

function explain(name, why) {
  return async (ctx) => {
    ctx.stderr.write(`${name}: ${why}\n`);
    return 126;
  };
}

const NO_EVAL =
  "can't run here: this host forbids code generation (eval, new Function), which Node.js in Lifo needs. " +
  'Run the box in a browser tab, in Node.js or in Lifo Cloud, or create it with createEdgeSandbox({ quickjs }) for a slower interpreter.';
const NO_WASM =
  "can't run here: Python (Pyodide) compiles WebAssembly at run time, which this host forbids. Run the box in a browser tab, in Node.js or in Lifo Cloud.";

/** Sandbox.create(), adjusted to what the host allows. */
export async function createEdgeSandbox({ quickjs, ...options } = {}) {
  const caps = hostCapabilities();
  if (!caps.compressionStream) installGzipFallback();
  const box = await Sandbox.create(options);
  if (!caps.codegen) box.commands.register('node', quickjs ? quickjsNode(quickjs) : explain('node', NO_EVAL));
  if (!caps.wasmCompile) for (const n of ['python', 'python3', 'pip', 'pip3']) box.commands.register(n, explain(n, NO_WASM));
  box.edge = { ...caps, node: caps.codegen ? 'v8' : quickjs ? 'quickjs' : 'unavailable' };
  return box;
}

// ── node on QuickJS ─────────────────────────────────────────────────────────────────────────────
// The script runs inside QuickJS; the host only exposes a few functions (write, file access, exit).
// require() is implemented inside QuickJS, so modules are evaluated by QuickJS's own compiler,
// never by the host's.

const PRELUDE = String.raw`
(() => {
  const host = globalThis.__host;
  const norm = (p) => {
    const abs = p.startsWith('/');
    const out = [];
    for (const s of p.split('/')) {
      if (!s || s === '.') continue;
      if (s === '..') out.pop(); else out.push(s);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  };
  const path = {
    sep: '/',
    join: (...a) => norm(a.filter(Boolean).join('/')),
    resolve: (...a) => { let r = host.cwd(); for (const p of a) r = p.startsWith('/') ? p : r + '/' + p; return norm(r); },
    dirname: (p) => { const n = norm(p); const i = n.lastIndexOf('/'); return i <= 0 ? (n.startsWith('/') ? '/' : '.') : n.slice(0, i); },
    basename: (p, ext) => { const b = norm(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: (p) => { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
    isAbsolute: (p) => p.startsWith('/'),
  };
  path.posix = path;
  const fmt = (v) => typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  const line = (args) => args.map(fmt).join(' ') + '\n';
  globalThis.console = {
    log: (...a) => host.write(1, line(a)), info: (...a) => host.write(1, line(a)),
    error: (...a) => host.write(2, line(a)), warn: (...a) => host.write(2, line(a)),
  };
  class Exit { constructor(code) { this.code = code; } }
  globalThis.process = {
    argv: JSON.parse(host.argv()), env: JSON.parse(host.env()), platform: 'linux', versions: { node: '22.0.0-quickjs' },
    cwd: () => host.cwd(), exit: (code = 0) => { throw new Exit(code); },
    stdout: { write: (s) => { host.write(1, String(s)); return true; } },
    stderr: { write: (s) => { host.write(2, String(s)); return true; } },
  };
  const fs = {
    readFileSync: (p, enc) => { const s = host.read(path.resolve(p)); return s; },
    writeFileSync: (p, data) => host.writeFile(path.resolve(p), String(data)),
    appendFileSync: (p, data) => host.appendFile(path.resolve(p), String(data)),
    existsSync: (p) => host.exists(path.resolve(p)),
    readdirSync: (p) => JSON.parse(host.readdir(path.resolve(p))),
    mkdirSync: (p, o) => host.mkdir(path.resolve(p), !!(o && o.recursive)),
    statSync: (p) => { const s = JSON.parse(host.stat(path.resolve(p))); return { ...s, isFile: () => s.type === 'file', isDirectory: () => s.type === 'directory' }; },
  };
  const builtins = { fs, path, 'node:fs': fs, 'node:path': path };
  const cache = {};
  const resolveFile = (from, req) => {
    const base = req.startsWith('/') ? req : path.join(path.dirname(from), req);
    for (const c of [base, base + '.js', base + '.cjs', base + '.json', base + '/index.js']) if (host.isFile(c)) return c;
    throw new Error("Cannot find module '" + req + "' from " + from);
  };
  const load = (file, source) => {
    if (cache[file]) return cache[file].exports;
    const module = { exports: {}, filename: file };
    cache[file] = module;
    const src = source === undefined ? host.read(file) : source;
    if (file.endsWith('.json')) { module.exports = JSON.parse(src); return module.exports; }
    const req = (r) => {
      if (builtins[r]) return builtins[r];
      if (r.startsWith('.') || r.startsWith('/')) return load(resolveFile(file, r));
      throw new Error("lifo-edge: require('" + r + "') isn't available on QuickJS (only fs, path and the box's own files)");
    };
    // QuickJS compiles this, not the host.
    const fn = (0, eval)('(function (exports, require, module, __filename, __dirname) {' + src + '\n})');
    fn(module.exports, req, module, file, path.dirname(file));
    return module.exports;
  };
  globalThis.__run = (mode, target) => {
    try {
      // -e code runs like a module in the working directory, with require, as in Node.
      if (mode === 'file') load(target);
      else load(host.cwd().replace(/\/$/, '') + '/[eval]', target);
      return 0;
    } catch (e) {
      if (e instanceof Exit) return e.code;
      host.write(2, (e && e.stack ? (e.name + ': ' + e.message + '\n' + e.stack) : String(e)) + '\n');
      return 1;
    }
  };
})();
`;

export function quickjsNode(quickjs, { cpuMs = 10_000 } = {}) {
  return async (ctx) => {
    const args = ctx.args;
    let mode;
    let target;
    let argv;
    if (args[0] === '-e' || args[0] === '--eval' || args[0] === '-p') {
      mode = 'code';
      target = args[0] === '-p' ? `console.log(${args[1] ?? 'undefined'})` : (args[1] ?? '');
      argv = ['node', ...args.slice(2)];
    } else if (args[0] === '-v' || args[0] === '--version') {
      ctx.stdout.write('v22.0.0-quickjs\n');
      return 0;
    } else if (args[0] && !args[0].startsWith('-')) {
      mode = 'file';
      target = args[0].startsWith('/') ? args[0] : `${ctx.cwd}/${args[0]}`.replace(/\/+/g, '/');
      if (!ctx.vfs.exists(target)) {
        ctx.stderr.write(`node: cannot find module '${target}'\n`);
        return 1;
      }
      argv = ['node', target, ...args.slice(1)];
    } else {
      ctx.stderr.write('node: on this host node runs on QuickJS: give it a file or -e; there is no interactive prompt.\n');
      return 1;
    }

    const vm = quickjs.newContext();
    const deadline = Date.now() + cpuMs;
    vm.runtime.setInterruptHandler(() => ctx.signal?.aborted || Date.now() > deadline);
    const host = vm.newObject();
    const fn = (name, impl) => {
      const h = vm.newFunction(name, (...hs) => {
        try {
          const out = impl(...hs.map((x) => vm.dump(x)));
          if (out === undefined) return vm.undefined;
          if (typeof out === 'boolean') return out ? vm.true : vm.false;
          return vm.newString(String(out));
        } catch (e) {
          return { error: vm.newError(String(e && e.message ? e.message : e)) };
        }
      });
      vm.setProp(host, name, h);
      h.dispose();
    };
    fn('write', (fd, s) => void (fd === 2 ? ctx.stderr : ctx.stdout).write(s));
    fn('cwd', () => ctx.cwd);
    fn('argv', () => JSON.stringify(argv));
    fn('env', () => JSON.stringify(ctx.env));
    fn('read', (p) => ctx.vfs.readFileString(p));
    fn('writeFile', (p, s) => void ctx.vfs.writeFile(p, s));
    fn('appendFile', (p, s) => void ctx.vfs.appendFile(p, s));
    fn('exists', (p) => ctx.vfs.exists(p));
    fn('isFile', (p) => ctx.vfs.exists(p) && ctx.vfs.stat(p).type === 'file');
    fn('readdir', (p) => JSON.stringify(ctx.vfs.readdir(p).map((d) => d.name)));
    fn('mkdir', (p, r) => void ctx.vfs.mkdir(p, { recursive: r }));
    fn('stat', (p) => {
      const s = ctx.vfs.stat(p);
      return JSON.stringify({ type: s.type, size: s.size, mtimeMs: s.mtime });
    });
    vm.setProp(vm.global, '__host', host);
    host.dispose();
    try {
      const pre = vm.evalCode(PRELUDE, 'lifo-edge-prelude.js');
      if (pre.error) {
        ctx.stderr.write(`node (quickjs): ${JSON.stringify(vm.dump(pre.error))}\n`);
        pre.error.dispose();
        return 1;
      }
      pre.value.dispose();
      const run = vm.getProp(vm.global, '__run');
      const res = vm.callFunction(run, vm.undefined, vm.newString(mode), vm.newString(target));
      run.dispose();
      if (res.error) {
        const err = vm.dump(res.error);
        res.error.dispose();
        const interrupted = /interrupted/i.test(JSON.stringify(err));
        ctx.stderr.write(interrupted ? `node (quickjs): stopped after ${cpuMs} ms\n` : `node (quickjs): ${JSON.stringify(err)}\n`);
        return interrupted ? 124 : 1;
      }
      const code = vm.dump(res.value);
      res.value.dispose();
      // Run queued promise jobs (async functions, .then) to completion.
      vm.runtime.executePendingJobs();
      return typeof code === 'number' ? code : 0;
    } finally {
      vm.dispose();
    }
  };
}
