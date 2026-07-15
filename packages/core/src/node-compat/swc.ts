/**
 * `@swc/core` shim backed by Lifo's (wasm) esbuild.
 *
 * `@swc/core` is a native Rust binding (`.node`); its loader even calls
 * `process.report.getReport()` before failing to find the binary. `@swc/wasm`
 * exists but is ~19 MB — too heavy to ship or fetch per project. Lifo already
 * has a wasm esbuild that transforms TS/JSX (it's how Vite runs here), so we
 * back `@swc/core`'s `transform` with it.
 *
 * The main consumer is `@vitejs/plugin-react-swc`, which calls the async
 * `transform(code, options)` and detects React Fast Refresh by testing the
 * OUTPUT for `$RefreshReg$(`. esbuild doesn't inject those, so the plugin
 * cleanly falls back to the plain compiled code — the app runs; HMR just does a
 * full reload instead of fast-refresh. That's the accepted trade-off for
 * running the plugin unmodified without native SWC.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SwcCtx {
  vfs: unknown;
  cwd: string;
}

function pickLoader(filename: string | undefined, options: any): 'tsx' | 'ts' | 'jsx' | 'js' {
  const f = String(filename ?? '');
  if (f.endsWith('.tsx')) return 'tsx';
  if (f.endsWith('.ts') || f.endsWith('.mts') || f.endsWith('.cts')) return 'ts';
  if (f.endsWith('.jsx')) return 'jsx';
  if (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')) return 'jsx';
  // Fall back to SWC's parser options.
  const p = options?.jsc?.parser;
  if (p?.syntax === 'typescript') return p?.tsx === false ? 'ts' : 'tsx';
  return 'jsx';
}

export function createSwcCore(ctx: SwcCtx, makeEsbuild: (c: SwcCtx) => any): Record<string, unknown> {
  const esb = makeEsbuild(ctx);

  async function transform(code: string, options?: any): Promise<{ code: string; map?: string }> {
    const react = options?.jsc?.transform?.react;
    const res = await esb.transform(code, {
      loader: pickLoader(options?.filename, options),
      jsx: react ? (react.runtime === 'automatic' ? 'automatic' : 'transform') : 'automatic',
      jsxDev: !!react?.development,
      jsxImportSource: react?.importSource || undefined,
      sourcemap: options?.sourceMaps ? true : false,
      sourcefile: options?.filename || undefined,
      target: 'es2020',
    });
    return { code: res.code, map: res.map ? res.map : undefined };
  }

  function transformSync(): never {
    throw new Error('[lifo] @swc/core.transformSync is unavailable in the browser VM — use the async transform().');
  }

  const unsupported = (name: string) => () => {
    throw new Error(`[lifo] @swc/core.${name}() is not supported in the browser VM.`);
  };

  const mod = {
    transform,
    transformSync,
    parse: async () => unsupported('parse')(),
    parseSync: unsupported('parseSync'),
    print: async () => unsupported('print')(),
    printSync: unsupported('printSync'),
    // Pass-through minify (esbuild bundling handles real minification elsewhere).
    minify: async (code: string) => ({ code }),
    minifySync: (code: string) => ({ code }),
  };
  return { ...mod, default: mod };
}
