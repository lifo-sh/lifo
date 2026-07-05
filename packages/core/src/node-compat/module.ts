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

  static builtinModules = builtinModules;
  static isBuiltin = isBuiltin;
  // createRequire is attached dynamically in createModuleShim()
  static createRequire: (filename: string | URL) => RequireFunction;

  static _resolveFilename(request: string): string {
    return request;
  }

  static _cache: Record<string, unknown> = {};
}

/**
 * Create the full module shim object with createRequire bound to a module map.
 */
export function createModuleShim(moduleMap: Record<string, () => unknown>) {
  const createRequire = makeCreateRequire(moduleMap);

  Module.createRequire = createRequire;

  return {
    Module,
    builtinModules,
    isBuiltin,
    createRequire,
    default: Module,
  };
}
