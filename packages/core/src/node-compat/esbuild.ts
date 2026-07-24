/**
 * esbuild shim that uses esbuild-wasm loaded from CDN (browser) or the real
 * esbuild package (Node hosts).
 *
 * When code inside Lifo does `require('esbuild')`, this shim is returned
 * instead of the native esbuild package (which can't run in the browser).
 *
 * The WASM binary is lazy-loaded on first transform/build call.
 *
 * build()/context() calls get a VFS bridge injected: esbuild-wasm has no
 * filesystem in the browser, and native esbuild would read the HOST fs —
 * both wrong for code living in Lifo's VFS. The bridge resolves imports
 * against the VFS (node_modules walk-up, package.json exports/main),
 * loads file contents from the VFS, and writes build outputs back to it.
 */

import { join, dirname } from '../utils/path.js';

interface MinimalVfs {
	exists(path: string): boolean;
	stat(path: string): { type: string };
	readFileString(path: string): string;
	writeFile(path: string, data: string | Uint8Array): void;
	mkdir(path: string, opts?: { recursive?: boolean }): void;
}

export interface EsbuildCtx {
	vfs: MinimalVfs;
	cwd: string;
}

// Kept in lockstep with the esbuild range Vite 7 expects (^0.27 || ^0.28)
// and with the host `esbuild` optionalDependency in package.json.
const ESBUILD_WASM_VERSION = '0.28.1';
const ESBUILD_WASM_URL = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esbuild.wasm`;
const ESBUILD_ESM_URL = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esm/browser.min.js`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let esbuildModule: any = null;
let initPromise: Promise<void> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureInitialized(): Promise<any> {
  if (esbuildModule) return esbuildModule;

  if (!initPromise) {
    initPromise = (async () => {
      // In a Node.js host (CLI daemon, headless sandbox) the CDN dynamic
      // import fails (Node's ESM loader rejects https: URLs), but the real
      // esbuild package is available — prefer it.
      const isNode =
        typeof process !== 'undefined' &&
        !!(process as { versions?: { node?: string } }).versions?.node &&
        typeof window === 'undefined';
      if (isNode) {
        try {
          // Computed specifier so the browser bundle doesn't rewrite this
          // to a browser-external stub — it must reach Node's real loader.
          const nodeModuleSpec = 'node' + ':module';
          const { createRequire } = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeModuleSpec);
          const req = createRequire(import.meta.url);
          esbuildModule = req('esbuild');
          return;
        } catch {
          // Host esbuild not installed — fall through to the wasm CDN path.
        }
      }

      // Use dynamic import from CDN
      // This works in browsers natively
      const mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ ESBUILD_ESM_URL);
      await mod.initialize({
        wasmURL: ESBUILD_WASM_URL,
      });
      esbuildModule = mod;
    })();
  }

  await initPromise;
  return esbuildModule;
}

const NODE_BUILTINS = new Set([
	'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https',
	'module', 'net', 'os', 'path', 'process', 'querystring', 'stream', 'string_decoder',
	'timers', 'tls', 'tty', 'url', 'util', 'worker_threads', 'zlib',
]);

const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json'];

function extToLoader(path: string): string {
	if (path.endsWith('.jsx')) return 'jsx';
	if (path.endsWith('.tsx')) return 'tsx';
	if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'ts';
	if (path.endsWith('.json')) return 'json';
	if (path.endsWith('.css')) return 'css';
	if (path.endsWith('.txt') || path.endsWith('.html')) return 'text';
	return 'js';
}

/** Node-style resolution against the VFS — enough for prebundling npm deps. */
function createVfsResolver(vfs: MinimalVfs) {
	function isFile(p: string): boolean {
		try { return vfs.stat(p).type === 'file'; } catch { return false; }
	}
	function isDir(p: string): boolean {
		try { return vfs.stat(p).type === 'directory'; } catch { return false; }
	}
	function resolveAsFile(p: string): string | null {
		if (isFile(p)) return p;
		for (const ext of RESOLVE_EXTS) if (isFile(p + ext)) return p + ext;
		return null;
	}
	/** Pick a target from a package.json "exports" value, preferring ESM-ish conditions. */
	function pickExport(val: unknown): string | null {
		if (typeof val === 'string') return val;
		if (Array.isArray(val)) {
			for (const v of val) { const r = pickExport(v); if (r) return r; }
			return null;
		}
		if (val && typeof val === 'object') {
			for (const cond of ['browser', 'import', 'module', 'default', 'require']) {
				if (cond in (val as Record<string, unknown>)) {
					const r = pickExport((val as Record<string, unknown>)[cond]);
					if (r) return r;
				}
			}
		}
		return null;
	}
	function resolveAsDir(p: string): string | null {
		const pkgPath = join(p, 'package.json');
		if (isFile(pkgPath)) {
			try {
				const pkg = JSON.parse(vfs.readFileString(pkgPath)) as Record<string, unknown>;
				for (const field of ['module', 'main']) {
					if (typeof pkg[field] === 'string') {
						const r = resolveAsFile(join(p, pkg[field] as string)) ?? resolveAsFile(join(p, pkg[field] as string, 'index'));
						if (r) return r;
					}
				}
			} catch { /* malformed package.json — fall through to index */ }
		}
		return resolveAsFile(join(p, 'index'));
	}
	function resolvePath(p: string): string | null {
		return resolveAsFile(p) ?? (isDir(p) ? resolveAsDir(p) : null);
	}
	function resolvePackageEntry(pkgRoot: string, subpath: string): string | null {
		const pkgPath = join(pkgRoot, 'package.json');
		if (isFile(pkgPath)) {
			try {
				const pkg = JSON.parse(vfs.readFileString(pkgPath)) as Record<string, unknown>;
				const exports = pkg.exports;
				if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
					const key = subpath ? `./${subpath}` : '.';
					const map = exports as Record<string, unknown>;
					const hasSubpathKeys = Object.keys(map).some((k) => k.startsWith('.'));
					const target = hasSubpathKeys ? map[key] : (subpath ? undefined : exports);
					if (target !== undefined) {
						const rel = pickExport(target);
						if (rel) return resolvePath(join(pkgRoot, rel));
					}
				} else if (typeof exports === 'string' && !subpath) {
					return resolvePath(join(pkgRoot, exports));
				}
			} catch { /* fall through */ }
		}
		return subpath ? resolvePath(join(pkgRoot, subpath)) : resolveAsDir(pkgRoot);
	}
	function resolveBare(spec: string, fromDir: string): string | null {
		const parts = spec.split('/');
		const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
		const subpath = spec.slice(pkgName.length + 1);
		let dir = fromDir;
		while (true) {
			const pkgRoot = join(dir, 'node_modules', pkgName);
			if (isDir(pkgRoot)) {
				const r = resolvePackageEntry(pkgRoot, subpath);
				if (r) return r;
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	}
	return { resolvePath, resolveBare, isFile };
}

/** esbuild plugin bridging resolution, loading, and output to the Lifo VFS. */
function createVfsPlugin(ctx: EsbuildCtx): Record<string, unknown> {
	const { resolvePath, resolveBare, isFile } = createVfsResolver(ctx.vfs);
	return {
		name: 'lifo-vfs',
		setup(build: {
			onResolve: (opts: { filter: RegExp }, cb: (args: { path: string; importer: string; resolveDir: string; namespace: string }) => unknown) => void;
			onLoad: (opts: { filter: RegExp; namespace?: string }, cb: (args: { path: string }) => unknown) => void;
		}) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.namespace && args.namespace !== 'file') return null;
				const p = args.path;
				if (/^(data:|https?:|node:)/.test(p)) return null;
				if (NODE_BUILTINS.has(p)) return { path: p, external: true };
				const baseDir = args.resolveDir || (args.importer ? dirname(args.importer) : ctx.cwd);
				let resolved: string | null = null;
				if (p.startsWith('/')) resolved = resolvePath(p);
				else if (p.startsWith('.')) resolved = resolvePath(join(baseDir, p));
				else resolved = resolveBare(p, baseDir);
				// null → let other plugins / esbuild's own resolver try
				return resolved ? { path: resolved, namespace: 'file' } : null;
			});
			build.onLoad({ filter: /.*/, namespace: 'file' }, (args) => {
				if (!isFile(args.path)) return null;
				return {
					contents: ctx.vfs.readFileString(args.path),
					loader: extToLoader(args.path),
					resolveDir: dirname(args.path),
				};
			});
		},
	};
}

/** Inject the VFS plugin and force write:false, writing outputs to the VFS instead. */
function prepareBuildOptions(options: Record<string, unknown> | undefined, ctx: EsbuildCtx): { opts: Record<string, unknown>; wantsWrite: boolean } {
	const opts = { ...(options ?? {}) };
	const wantsWrite = opts.write !== false;
	opts.write = false;
	opts.plugins = [...((opts.plugins as unknown[] | undefined) ?? []), createVfsPlugin(ctx)];
	return { opts, wantsWrite };
}

function writeOutputsToVfs(result: { outputFiles?: Array<{ path: string; contents: Uint8Array }> }, ctx: EsbuildCtx): void {
	for (const file of result.outputFiles ?? []) {
		ctx.vfs.mkdir(dirname(file.path), { recursive: true });
		ctx.vfs.writeFile(file.path, file.contents);
	}
}

export function createEsbuild(ctx?: EsbuildCtx): Record<string, unknown> {
  const mod: Record<string, unknown> = {
    version: ESBUILD_WASM_VERSION,

    initialize: async (_options?: unknown): Promise<void> => {
      await ensureInitialized();
    },

    transform: async (code: string, options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.transform(code, options);
    },

    transformSync: (code: string, options?: unknown): unknown => {
      if (esbuildModule?.transformSync) return esbuildModule.transformSync(code, options);
      throw new Error('[lifo] esbuild.transformSync() is not available in browser. Use transform() instead.');
    },

    build: async (options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      if (!ctx) return esb.build(options);
      const { opts, wantsWrite } = prepareBuildOptions(options as Record<string, unknown>, ctx);
      const result = await esb.build(opts);
      if (wantsWrite) writeOutputsToVfs(result, ctx);
      return result;
    },

    buildSync: (options?: unknown): unknown => {
      if (esbuildModule?.buildSync) return esbuildModule.buildSync(options);
      throw new Error('[lifo] esbuild.buildSync() is not available in browser. Use build() instead.');
    },

    formatMessages: async (messages: unknown, options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.formatMessages(messages, options);
    },

    analyzeMetafile: async (metafile: unknown, options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      return esb.analyzeMetafile(metafile, options);
    },

    context: async (options?: unknown): Promise<unknown> => {
      const esb = await ensureInitialized();
      if (!ctx) return esb.context(options);
      const { opts, wantsWrite } = prepareBuildOptions(options as Record<string, unknown>, ctx);
      const inner = await esb.context(opts);
      return {
        ...inner,
        rebuild: async () => {
          const result = await inner.rebuild();
          if (wantsWrite) writeOutputsToVfs(result, ctx);
          return result;
        },
        watch: async () => { /* VFS watch integration not needed for prebundling */ },
        dispose: () => inner.dispose(),
        cancel: () => inner.cancel?.(),
      };
    },

    stop: (): void => {
      // No-op in browser
    },
  };

  return mod;
}
