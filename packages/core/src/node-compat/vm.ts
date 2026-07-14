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
 * loaders. Contexts are treated as plain objects.
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
  runInContext(_contextifiedObject?: unknown, _options?: unknown): unknown {
    return globalEval(this.code);
  }
  runInNewContext(_contextObject?: unknown, _options?: unknown): unknown {
    return globalEval(this.code);
  }
}

function createContext(contextObject?: any): any {
  return contextObject ?? {};
}

function isContext(_obj: unknown): boolean {
  return false;
}

function runInContext(code: string, _contextifiedObject?: unknown, _options?: unknown): unknown {
  return globalEval(String(code));
}

function runInNewContext(code: string, _contextObject?: unknown, _options?: unknown): unknown {
  return globalEval(String(code));
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
