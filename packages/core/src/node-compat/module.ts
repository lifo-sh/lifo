/**
 * Node.js `module` shim for Lifo.
 *
 * Provides the commonly used APIs from the `node:module` built-in:
 * - Module class with id, filename, exports, paths, require, etc.
 * - createRequire() — returns a require-like function backed by the module map
 * - builtinModules — list of shimmed built-in module names
 * - isBuiltin() — check if a module name is a built-in
 */

/** All built-in module names available in the Lifo node-compat layer */
export const builtinModules: string[] = [
  'assert',
  'buffer',
  'child_process',
  'console',
  'constants',
  'crypto',
  'dns',
  'dns/promises',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'vm',
  'worker_threads',
  'zlib',
];

/**
 * Check whether a specifier refers to a Node.js built-in module.
 * Handles both bare names ("fs") and the "node:" prefix ("node:fs").
 */
export function isBuiltin(specifier: string): boolean {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return builtinModules.includes(name);
}

export type RequireFunction = ((id: string) => unknown) & {
  resolve: (id: string) => string;
  cache: Record<string, unknown>;
};

/**
 * Factory for createRequire — needs the module map from index.ts at runtime.
 * Called from createModuleMap() so it has access to the lazily-built map.
 */
export function makeCreateRequire(
  moduleMap: Record<string, () => unknown>,
): (filename: string | URL) => RequireFunction {
  return function createRequire(_filename: string | URL): RequireFunction {
    const cache: Record<string, unknown> = {};

    const req = function require(id: string): unknown {
      const name = id.startsWith('node:') ? id.slice(5) : id;

      if (cache[name]) return cache[name];

      if (moduleMap[name]) {
        const mod = moduleMap[name]();
        cache[name] = mod;
        return mod;
      }

      throw new Error(`Cannot find module '${id}'`);
    } as RequireFunction;

    req.resolve = (id: string): string => {
      const name = id.startsWith('node:') ? id.slice(5) : id;
      if (moduleMap[name]) return name;
      throw new Error(`Cannot find module '${id}'`);
    };

    req.cache = cache;

    return req;
  };
}

/**
 * Minimal Module class matching the shape code typically expects.
 */

/** Context hooks the node command wires in so Module instances can execute code. */
interface ModuleShimHooks {
  executeCjs?: (code: string, filename: string) => unknown;
}

export class Module {
  id: string;
  filename: string;
  exports: unknown;
  parent: Module | null;
  children: Module[];
  loaded: boolean;
  paths: string[];

  constructor(id = '', parent: Module | null = null) {
    this.id = id;
    this.filename = id;
    this.exports = {};
    this.parent = parent;
    this.children = [];
    this.loaded = false;
    this.paths = [];
  }

  require(_id: string): unknown {
    throw new Error('Module.require() is not supported — use createRequire() instead');
  }

  /**
   * Compile + execute CJS source as this module's body (Node semantics), via
   * the node command's module executor. Packages like require-from-string
   * (used by @expo/config to evaluate app.config.js) construct a Module and
   * call this directly.
   */
  _compile(code: string, filename: string): unknown {
    const ctor = this.constructor as typeof Module;
    const exec = ctor._hooks?.executeCjs ?? Module._hooks?.executeCjs;
    if (!exec) {
      throw new Error('module._compile is unavailable outside the node command');
    }
    this.exports = exec(code, filename || this.filename);
    this.loaded = true;
    return this.exports;
  }

  static builtinModules = builtinModules;
  static isBuiltin = isBuiltin;
  // createRequire is attached dynamically in createModuleShim()
  static createRequire: (filename: string | URL) => RequireFunction;
  /** Runtime hooks (CJS executor) — attached by createModuleShim. */
  static _hooks: ModuleShimHooks | undefined;

  /** Node's node_modules lookup chain for a directory (posix walk-up). */
  static _nodeModulePaths(from: string): string[] {
    const paths: string[] = [];
    let dir = (from || '/').replace(/\/+$/, '') || '/';
    for (;;) {
      if (!dir.endsWith('/node_modules')) {
        paths.push(dir === '/' ? '/node_modules' : dir + '/node_modules');
      }
      const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
      if (parent === dir) break;
      dir = parent;
    }
    return paths;
  }

  static _resolveFilename(request: string): string {
    return request;
  }

  /**
   * Node's require-extension loader map. Consumers (e.g. @expo/require-utils'
   * resolveFrom) read `Object.keys(Module._extensions)` to get the default
   * candidate extensions when resolving a bare specifier. The loader fns are
   * unused by our resolver, so they're no-ops — only the keys matter.
   */
  static _extensions: Record<string, unknown> = {
    '.js': () => {},
    '.json': () => {},
    '.node': () => {},
  };

  static _cache: Record<string, unknown> = {};
}

/**
 * Create the module shim with createRequire bound to a module map. Returns the
 * Module class itself — in Node, `require('module')` IS the Module constructor
 * (require-from-string does `new (require('module'))(...)`) — with the named
 * APIs attached as statics.
 */
export function createModuleShim(
  moduleMap: Record<string, () => unknown>,
  hooks?: ModuleShimHooks,
) {
  Module.createRequire = makeCreateRequire(moduleMap);
  if (hooks) Module._hooks = hooks;

  const M = Module as typeof Module & {
    Module: typeof Module;
    default: typeof Module;
  };
  M.Module = Module;
  M.default = Module;
  return M;
}

/**
 * Create a fresh, constructable Module class with its own static overrides —
 * used by the node command, whose `require('module')` must expose its scoped
 * require (VFS + node_modules resolution) while staying `new`-able with a
 * working #_compile (require-from-string, @expo/config dynamic configs).
 */
export function createModuleClass(
  hooks: ModuleShimHooks | undefined,
  statics: Record<string, unknown>,
): typeof Module {
  class NodeModule extends Module {}
  const M = NodeModule as typeof Module & Record<string, unknown>;
  M._hooks = hooks;
  Object.assign(M, statics);
  M.Module = M;
  M.default = M;
  return M;
}
