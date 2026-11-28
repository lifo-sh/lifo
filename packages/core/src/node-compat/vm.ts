/**
 * Minimal `vm` module shim.
 *
 * The browser VM has no real isolated V8 contexts, but tools that pull in `vm`
 * mostly use it to *evaluate transpiled code* — notably `jiti` (the runtime
 * TS/ESM loader behind `@tailwindcss/node`, unbuild, many configs), which calls
 * `vm.runInThisContext(code, opts)` on a wrapped module function and runs the
 * returned function itself.
 *
 * We evaluate in the current realm's global scope via indirect eval. That's not
 * a security boundary (Lifo's isolation is JS-level regardless), but it makes
 * `runInThisContext` / `Script` / `compileFunction` behave correctly for these
 * loaders.
 *
 * A context (runInContext / runInNewContext) is the code's global scope: free variables and
 * `globalThis` read and write the context object, with the realm's built-ins (Array, JSON,
 * ...) behind it, as in a fresh Node context. Next.js loads its manifests this way
 * (`globalThis.__RSC_MANIFEST = ...` into the object it passes). Unlike Node, a top-level
 * `var` stays local to the script rather than becoming a property of the context.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, no-eval */

// Indirect eval → evaluates in global scope and returns the completion value
// (e.g. the wrapped `(function(exports, require, module, …){…})` jiti produces).
const globalEval: (code: string) => any = eval;

function runInThisContext(code: string, _options?: unknown): unknown {
  return globalEval(String(code));
}

class Script {
  private code: string;
  constructor(code: string, _options?: unknown) {
    this.code = String(code);
  }
  runInThisContext(_options?: unknown): unknown {
    return globalEval(this.code);
  }
  runInContext(contextifiedObject?: unknown, options?: unknown): unknown {
    return runInContext(this.code, contextifiedObject, options);
  }
  runInNewContext(contextObject?: unknown, options?: unknown): unknown {
    return runInNewContext(this.code, contextObject, options);
  }
}

const contexts = new WeakSet<object>();

function createContext(contextObject?: any): any {
  const ctx = contextObject ?? {};
  if (typeof ctx === 'object' && ctx !== null) contexts.add(ctx);
  return ctx;
}

function isContext(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && contexts.has(obj);
}

const realm = globalThis as unknown as Record<string | symbol, unknown>;

/** Run `code` with `ctx` as its global object; returns the completion value. */
function evalInContext(code: string, ctx: Record<string | symbol, unknown>): unknown {
  // `globalThis` (and `this`) in the script: the context, with the realm's built-ins behind it.
  const global: Record<string | symbol, unknown> = new Proxy(ctx, {
    get: (t, k) => (k in t ? t[k] : k === 'globalThis' ? global : realm[k]),
    set: (t, k, v) => { t[k] = v; return true; },
    has: (t, k) => k in t || k in realm,
  });
  // The scope `with` looks names up in: every name is the context's, so a bare assignment
  // lands on it, and anything it lacks falls through to the realm (Array, JSON, setTimeout).
  const scope = new Proxy(ctx, {
    has: (_t, k) => k !== Symbol.unscopables && k !== '__lifoVmCode',
    get: (t, k) => (k === Symbol.unscopables ? undefined : k === 'globalThis' ? global : k in t ? t[k] : realm[k]),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  // Sloppy-mode wrapper (`with` isn't allowed in strict code); the direct eval inside it sees
  // the `with` scope and returns the script's completion value.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function('__lifoVmScope', '__lifoVmCode', 'with (__lifoVmScope) { return eval(__lifoVmCode); }');
  return run.call(global, scope, String(code));
}

function runInContext(code: string, contextifiedObject?: unknown, _options?: unknown): unknown {
  if (typeof contextifiedObject !== 'object' || contextifiedObject === null) return globalEval(String(code));
  return evalInContext(String(code), contextifiedObject as Record<string | symbol, unknown>);
}

function runInNewContext(code: string, contextObject?: unknown, _options?: unknown): unknown {
  return evalInContext(String(code), createContext(contextObject ?? {}));
}

function compileFunction(
  code: string,
  params: string[] = [],
  _options?: unknown,
): (...args: unknown[]) => unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(...params, String(code)) as (...args: unknown[]) => unknown;
}

function measureMemory(): Promise<unknown> {
  return Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } });
}

export function createVm(): Record<string, unknown> {
  const mod = {
    runInThisContext,
    runInContext,
    runInNewContext,
    createContext,
    isContext,
    compileFunction,
    measureMemory,
    Script,
    // constants Node exposes; harmless placeholders
    constants: { DONT_CONTEXTIFY: Symbol('DONT_CONTEXTIFY'), USE_MAIN_CONTEXT_DEFAULT_LOADER: 0 },
  };
  return { ...mod, default: mod };
}
