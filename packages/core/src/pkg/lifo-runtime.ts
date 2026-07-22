/**
 * Lifo Runtime -- enhanced execution context for lifo-native packages.
 *
 * Packages with a "lifo" field in package.json get this runtime instead of
 * the plain CJS node runner.  It provides:
 *   - lifo.import()   – load ESM modules from a configurable CDN (default esm.sh)
 *   - lifo.loadWasm() – fetch + cache WebAssembly modules
 *   - lifo.resolve()  – resolve a path relative to cwd
 */

import type { Command, CommandContext } from '../commands/types.js';
import type { VFS } from '../kernel/vfs/index.js';
import { resolve, dirname, join } from '../utils/path.js';
import { createProcess } from '../node-compat/process.js';
import { createConsole } from '../node-compat/console.js';
import { Buffer } from '../node-compat/buffer.js';
import { createModuleMap } from '../node-compat/index.js';
import { ProcessExitError } from '../node-compat/index.js';
import type { NodeContext } from '../node-compat/index.js';

// ─── Types ───

export interface LifoPackageManifest {
  commands: Record<string, string>;  // command name -> relative path to entry JS
}

export interface LifoAPI {
  /** Import an ESM module from CDN.  Cached after first load. */
  import(specifier: string): Promise<unknown>;

  /** Fetch, compile and cache a WebAssembly module from a URL. */
  loadWasm(url: string): Promise<WebAssembly.Module>;

  /** Resolve a path relative to the command's cwd. */
  resolve(path: string): string;

  /** The CDN base URL currently in use. */
  readonly cdn: string;
}

// ─── CDN + WASM cache ───

const DEFAULT_CDN = 'https://esm.sh';

/** In-memory cache for CDN imports (survives across command invocations). */
const esmCache = new Map<string, unknown>();

/** In-memory cache for compiled WASM modules. */
const wasmCache = new Map<string, WebAssembly.Module>();

function getCdn(env: Record<string, string>): string {
  return env.LIFO_CDN || DEFAULT_CDN;
}

function createLifoAPI(ctx: CommandContext): LifoAPI {
  const cdn = getCdn(ctx.env);

  return {
    cdn,

    async import(specifier: string): Promise<unknown> {
      // Allow full URLs to pass through
      const url = specifier.startsWith('http://') || specifier.startsWith('https://')
        ? specifier
        : `${cdn}/${specifier}`;

      const cached = esmCache.get(url);
      if (cached) return cached;

      const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
      esmCache.set(url, mod);
      return mod;
    },

    async loadWasm(url: string): Promise<WebAssembly.Module> {
      const cached = wasmCache.get(url);
      if (cached) return cached;

      const response = await fetch(url, { signal: ctx.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }

      const bytes = await response.arrayBuffer();
      const mod = await WebAssembly.compile(bytes);
      wasmCache.set(url, mod);
      return mod;
    },

    resolve(path: string): string {
      return resolve(ctx.cwd, path);
    },
  };
}

// ─── Command loader ───

/** Strip shebang line, preserve line numbers. */
function stripShebang(src: string): string {
  if (src.charCodeAt(0) === 0x23 && src.charCodeAt(1) === 0x21) {
    const nl = src.indexOf('\n');
    if (nl === -1) return '';
    return '\n' + src.slice(nl + 1);
  }
  return src;
}

// ─── ESM detection & rewriting ───

/** Quick check: does the source use ESM syntax (import/export at top level)? */
function isEsmSource(source: string): boolean {
  // Match import/export at the start of a line (not inside strings)
  return /(?:^|\n)\s*(?:import\s|export\s)/m.test(source);
}

/**
 * Rewrite bare specifier imports/exports to CDN URLs so the module
 * can be loaded via blob URL + import().
 *
 *   import { X } from 'foo'  →  import { X } from 'https://esm.sh/foo'
 *   import('foo')             →  import('https://esm.sh/foo')
 */
function rewriteImportsToCdn(source: string, cdn: string): string {
  // Static imports/re-exports: from 'specifier' or from "specifier"
  let result = source.replace(
    /(from\s+)(["'])([^"'./][^"']*)\2/g,
    (_, prefix, quote, spec) => `${prefix}${quote}${cdn}/${spec}${quote}`,
  );
  // Dynamic import(): import('specifier') or import("specifier")
  result = result.replace(
    /(import\s*\(\s*)(["'])([^"'./][^"']*)\2(\s*\))/g,
    (_, prefix, quote, spec, suffix) => `${prefix}${quote}${cdn}/${spec}${quote}${suffix}`,
  );
  return result;
}

/**
 * Create a Command that executes a lifo-native package entry.
 *
 * Supports two module formats:
 *   - ESM: import/export syntax → loaded via blob URL + import()
 *   - CJS: module.exports = async function(ctx, lifo) { ... }
 */
export function createLifoCommand(
  entryPath: string,
  vfs: VFS,
): Command {
  return async (ctx: CommandContext): Promise<number> => {
    const source = vfs.readFileString(entryPath);
    const lifo = createLifoAPI(ctx);

    // ── ESM path: rewrite imports to CDN, load via blob URL ──
    if (isEsmSource(source)) {
      return executeEsmCommand(source, ctx, lifo);
    }

    // ── CJS path: wrap in new Function() ──
    return executeCjsCommand(source, entryPath, vfs, ctx, lifo);
  };
}

/** Detect if we're running in Node.js (vs browser). */
const _g = globalThis as Record<string, unknown>;
const isNode = typeof _g['process'] !== 'undefined'
  && typeof (_g['process'] as Record<string, unknown>)?.['versions'] !== 'undefined'
  && typeof ((_g['process'] as Record<string, unknown>)?.['versions'] as Record<string, unknown>)?.['node'] === 'string';

// ─── Node.js HTTPS loader ───
// Node.js doesn't support import() from https: URLs. We register a custom
// ESM loader (via module.register) that intercepts https: imports, fetches
// the source with fetch(), and returns it as a module.

let _loaderRegistered = false;

async function ensureHttpsLoader(): Promise<void> {
  if (_loaderRegistered || !isNode) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const modId = 'node:' + 'module'; // prevent static analysis
    const nodeModule: { register?: (specifier: string) => void } =
      await import(/* @vite-ignore */ /* webpackIgnore: true */ modId);
    if (typeof nodeModule.register !== 'function') {
      // Node.js < 20.6 -- module.register() not available
      return;
    }

    // The loader code runs in a separate thread. It handles:
    // 1. Absolute https/http URLs as import specifiers
    // 2. Relative imports (./foo, ../bar) from an https parent
    const loaderCode = [
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (specifier.startsWith("https://") || specifier.startsWith("http://")) {',
      '    return { url: specifier, shortCircuit: true };',
      '  }',
      '  if (context.parentURL && (context.parentURL.startsWith("https://") || context.parentURL.startsWith("http://"))',
      '      && (specifier.startsWith("./") || specifier.startsWith("../"))) {',
      '    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      '',
      'export async function load(url, context, nextLoad) {',
      '  if (url.startsWith("https://") || url.startsWith("http://")) {',
      '    const response = await fetch(url);',
      '    if (!response.ok) throw new Error("Failed to fetch " + url + ": " + response.status);',
      '    const source = await response.text();',
      '    return { format: "module", source, shortCircuit: true };',
      '  }',
      '  return nextLoad(url, context);',
      '}',
    ].join('\n');

    const NodeBuffer = (_g['Buffer'] as { from(s: string, e: string): { toString(e: string): string } });
    const encoded = NodeBuffer.from(loaderCode, 'utf-8').toString('base64');
    nodeModule.register(`data:text/javascript;base64,${encoded}`);
    _loaderRegistered = true;
  } catch {
    // Silently fail -- will surface as import errors later
  }
}

async function executeEsmCommand(
  source: string,
  ctx: CommandContext,
  lifo: LifoAPI,
): Promise<number> {
  const cdn = getCdn(ctx.env);
  const rewritten = rewriteImportsToCdn(source, cdn);

  // In Node.js, register an HTTPS loader so CDN imports work,
  // and use data: URLs (Node doesn't support blob: for import).
  if (isNode) {
    await ensureHttpsLoader();
  }

  let url: string;
  let needsRevoke = false;

  if (isNode) {
    const encoded = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(rewritten)))
      : (_g['Buffer'] as { from(s: string, e: string): { toString(e: string): string } }).from(rewritten, 'utf-8').toString('base64');
    url = `data:text/javascript;base64,${encoded}`;
  } else {
    const blob = new Blob([rewritten], { type: 'application/javascript' });
    url = URL.createObjectURL(blob);
    needsRevoke = true;
  }

  try {
    const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
    const handler = mod.default;

    if (typeof handler !== 'function') {
      ctx.stderr.write('lifo: ESM module does not export a default command function\n');
      return 1;
    }

    const exitCode = await handler(ctx, lifo);
    return typeof exitCode === 'number' ? exitCode : 0;
  } catch (e) {
    if (e instanceof Error) {
      ctx.stderr.write(`${e.stack || e.message}\n`);
    } else {
      ctx.stderr.write(`${String(e)}\n`);
    }
    return 1;
  } finally {
    if (needsRevoke) {
      URL.revokeObjectURL(url);
    }
  }
}

function executeCjsCommand(
  source: string,
  entryPath: string,
  vfs: VFS,
  ctx: CommandContext,
  lifo: LifoAPI,
): Promise<number> {
  const entryDir = dirname(entryPath);

  // Build a node-compat context for require()
  const nodeCtx: NodeContext = {
    vfs: ctx.vfs,
    cwd: ctx.cwd,
    env: ctx.env,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    argv: [entryPath, ...ctx.args],
    filename: entryPath,
    dirname: entryDir,
    signal: ctx.signal,
  };

  const moduleMap = createModuleMap(nodeCtx);
  const moduleCache = new Map<string, unknown>();

  // Minimal require for lifo commands
  function lifoRequire(name: string): unknown {
    if (moduleCache.has(name)) return moduleCache.get(name);

    // Built-in modules
    if (moduleMap[name]) {
      const mod = moduleMap[name]();
      moduleCache.set(name, mod);
      return mod;
    }

    // Relative files
    if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
      const absPath = resolve(entryDir, name);
      const candidates = [absPath, absPath + '.js', absPath + '.json'];
      for (const p of candidates) {
        if (vfs.exists(p)) {
          if (p.endsWith('.json')) {
            const parsed = JSON.parse(vfs.readFileString(p));
            moduleCache.set(name, parsed);
            return parsed;
          }
          const childSrc = vfs.readFileString(p);
          const childMod = executeModule(childSrc, p);
          moduleCache.set(name, childMod);
          return childMod;
        }
      }
      // Try directory with index.js
      const indexPath = join(absPath, 'index.js');
      if (vfs.exists(indexPath)) {
        const childSrc = vfs.readFileString(indexPath);
        const childMod = executeModule(childSrc, indexPath);
        moduleCache.set(name, childMod);
        return childMod;
      }
      throw new Error(`Cannot find module '${name}'`);
    }

    // node_modules resolution (walk up)
    const resolved = resolveNodeModule(name, entryDir);
    if (resolved) {
      if (moduleCache.has(resolved)) return moduleCache.get(resolved);
      if (resolved.endsWith('.json')) {
        const parsed = JSON.parse(vfs.readFileString(resolved));
        moduleCache.set(resolved, parsed);
        return parsed;
      }
      const childSrc = vfs.readFileString(resolved);
      const childMod = executeModule(childSrc, resolved);
      moduleCache.set(resolved, childMod);
      return childMod;
    }

    throw new Error(`Cannot find module '${name}'`);
  }

  function resolveNodeModule(name: string, fromDir: string): string | null {
    let pkgName: string;
    let subpath: string | null = null;

    if (name.startsWith('@')) {
      const parts = name.split('/');
      if (parts.length < 2) return null;
      pkgName = parts[0] + '/' + parts[1];
      if (parts.length > 2) subpath = parts.slice(2).join('/');
    } else {
      const idx = name.indexOf('/');
      if (idx !== -1) {
        pkgName = name.slice(0, idx);
        subpath = name.slice(idx + 1);
      } else {
        pkgName = name;
      }
    }

    // Walk up
    let cur = fromDir;
    for (;;) {
      const candidate = join(cur, 'node_modules', pkgName);
      if (vfs.exists(candidate)) {
        return resolvePackageEntry(candidate, subpath);
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    // Global + legacy
    for (const base of ['/usr/lib/node_modules', '/usr/share/pkg/node_modules']) {
      const candidate = join(base, pkgName);
      if (vfs.exists(candidate)) {
        return resolvePackageEntry(candidate, subpath);
      }
    }

    return null;
  }

  function resolvePackageEntry(pkgDir: string, subpath: string | null): string | null {
    if (subpath) {
      const abs = resolve(pkgDir, subpath);
      for (const p of [abs, abs + '.js', abs + '.json']) {
        if (vfs.exists(p)) return p;
      }
      const idx = join(abs, 'index.js');
      if (vfs.exists(idx)) return idx;
      return null;
    }

    const pkgJsonPath = join(pkgDir, 'package.json');
    if (vfs.exists(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(vfs.readFileString(pkgJsonPath));
        if (pkg.main) {
          const mainPath = resolve(pkgDir, pkg.main);
          for (const p of [mainPath, mainPath + '.js']) {
            if (vfs.exists(p)) return p;
          }
        }
      } catch { /* ignore */ }
    }

    const indexPath = join(pkgDir, 'index.js');
    if (vfs.exists(indexPath)) return indexPath;
    return null;
  }

  function executeModule(modSource: string, modFilename: string): unknown {
    const modDir = dirname(modFilename);
    const modModule = { exports: {} as Record<string, unknown> };
    const modExports = modModule.exports;

    const modProcess = createProcess({
      argv: nodeCtx.argv,
      env: nodeCtx.env,
      cwd: nodeCtx.cwd,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    });
    const modConsole = createConsole(ctx.stdout, ctx.stderr);

    function modRequire(n: string): unknown {
      // Update resolution base to this module's directory
      if (n.startsWith('./') || n.startsWith('../')) {
        const abs = resolve(modDir, n);
        const candidates = [abs, abs + '.js', abs + '.json'];
        for (const p of candidates) {
          if (vfs.exists(p)) {
            if (moduleCache.has(p)) return moduleCache.get(p);
            if (p.endsWith('.json')) {
              const parsed = JSON.parse(vfs.readFileString(p));
              moduleCache.set(p, parsed);
              return parsed;
            }
            const src = vfs.readFileString(p);
            return executeModule(src, p);
          }
        }
        const idx = join(abs, 'index.js');
        if (vfs.exists(idx)) {
          if (moduleCache.has(idx)) return moduleCache.get(idx);
          const src = vfs.readFileString(idx);
          return executeModule(src, idx);
        }
        throw new Error(`Cannot find module '${n}'`);
      }
      return lifoRequire(n);
    }

    const clean = stripShebang(modSource);
    const wrapped = `(function(exports,require,module,__filename,__dirname,console,process,Buffer,setTimeout,setInterval,clearTimeout,clearInterval,global){\n${clean}\n})`;

    const fn = new Function('return ' + wrapped)();
    fn(
      modExports, modRequire, modModule, modFilename, modDir,
      modConsole, modProcess, Buffer,
      globalThis.setTimeout, globalThis.setInterval,
      globalThis.clearTimeout, globalThis.clearInterval,
      {},
    );

    return modModule.exports !== modExports ? modModule.exports : modExports;
  }

  // ── Execute the CJS entry ──

  const cjsProcess = createProcess({
    argv: nodeCtx.argv,
    env: nodeCtx.env,
    cwd: nodeCtx.cwd,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
  const nodeConsole = createConsole(ctx.stdout, ctx.stderr);

  const module = { exports: {} as Record<string, unknown> };
  const exports = module.exports;

  const cleanSource = stripShebang(source);
  const wrapped = `(function(exports,require,module,__filename,__dirname,console,process,Buffer,setTimeout,setInterval,clearTimeout,clearInterval,global){\n${cleanSource}\n})`;

  try {
    const fn = new Function('return ' + wrapped)();
    fn(
      exports, lifoRequire, module, entryPath, entryDir,
      nodeConsole, cjsProcess, Buffer,
      globalThis.setTimeout, globalThis.setInterval,
      globalThis.clearTimeout, globalThis.clearInterval,
      {},
    );

    // The entry should export a function: module.exports = async function(ctx, lifo) { ... }
    const handler = typeof module.exports === 'function'
      ? module.exports
      : (module.exports as Record<string, unknown>).default;

    if (typeof handler !== 'function') {
      ctx.stderr.write(`lifo: ${entryPath} does not export a command function\n`);
      return Promise.resolve(1);
    }

    return (handler as (c: CommandContext, l: LifoAPI) => Promise<number>)(ctx, lifo)
      .then(code => typeof code === 'number' ? code : 0);
  } catch (e) {
    if (e instanceof ProcessExitError) {
      return Promise.resolve(e.exitCode);
    }
    if (e instanceof Error) {
      ctx.stderr.write(`${e.stack || e.message}\n`);
    } else {
      ctx.stderr.write(`${String(e)}\n`);
    }
    return Promise.resolve(1);
  }
}

// ─── Package detection ───

export interface LifoPackageJson {
  name?: string;
  version?: string;
  lifo?: LifoPackageManifest;
  bin?: string | Record<string, string>;
}

/**
 * Read a package.json and return the lifo manifest if present.
 */
export function readLifoManifest(vfs: VFS, pkgDir: string): LifoPackageManifest | null {
  const pkgJsonPath = join(pkgDir, 'package.json');
  try {
    const pkg: LifoPackageJson = JSON.parse(vfs.readFileString(pkgJsonPath));
    return pkg.lifo || null;
  } catch {
    return null;
  }
}
