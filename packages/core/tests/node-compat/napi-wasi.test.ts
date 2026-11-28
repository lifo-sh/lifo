import { describe, it, expect, afterEach } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createFs } from '../../src/node-compat/fs.js';
import { createActivityTracker } from '../../src/node-compat/activity.js';
import { createNapiWasiRuntime, embeddedRuntimeSource, isNapiWasiLoader, isWasmThreadsUnavailable, type NapiWasiRuntime } from '../../src/node-compat/napi-wasi/index.js';

// A stand-in for @napi-rs/wasm-runtime, run inside the WASI thread. Its WASI constructor is
// the probe: it uses the `fs` the thread hands it (the box's, over the blocking channel) the
// way @tybys/wasm-util does, and posts what it saw back to the main thread.
const FAKE_RUNTIME = `
function MessageHandler(opts) { this.onLoad = opts.onLoad; }
MessageHandler.prototype.handle = function (e) {
  var d = e.data && e.data.__emnapi__;
  if (!d || d.type !== 'load') return;
  try { this.onLoad(d.payload); }
  catch (err) { postMessage({ probe: 'error', message: String(err && err.stack || err) }); }
};
function WASI(o) {
  var fs = o.fs, out = {};
  var st = fs.statSync('/data/hello.txt', { bigint: true });
  out.size = typeof st.size + ':' + String(st.size);
  out.isFile = st.isFile();
  out.isDirectory = st.isDirectory();
  out.mtimeIsDate = st.mtime instanceof Date;
  out.dirents = fs.readdirSync('/data', { withFileTypes: true })
    .map(function (d) { return d.name + (d.isDirectory() ? '/' : ''); }).sort();
  try { fs.openSync('/data/missing', 0); out.missing = 'no error'; } catch (e) { out.missing = e.code; }
  var fd = fs.openSync('/data/hello.txt', 0);
  var shared = new Uint8Array(new SharedArrayBuffer(5));
  out.readShared = fs.readSync(fd, shared, 0, 5, 0) + ':' + new TextDecoder().decode(shared.slice());
  var plain = new Uint8Array(5);
  out.readPlain = fs.readSync(fd, plain, 0, 5, 6) + ':' + new TextDecoder().decode(plain);
  fs.closeSync(fd);
  out.bigListing = fs.readdirSync('/data/many').length;
  var w = fs.openSync('/data/out.txt', 0x241);
  fs.writeSync(w, new TextEncoder().encode('from a thread'));
  fs.closeSync(w);
  o.print('printed from wasm');
  postMessage({ probe: 'done', out: out, env: o.env.PROBE_ENV, preopens: o.preopens });
}
module.exports = { MessageHandler: MessageHandler, WASI: WASI, instantiateNapiModuleSync: function () { return {}; } };
`;

const RUNTIME_FILES: Record<string, string> = {
	'/app/node_modules/@napi-rs/wasm-runtime/runtime.cjs': FAKE_RUNTIME,
	'/app/node_modules/x-wasm32-wasi/wasi-worker.mjs': '// uses emnapiAsyncWorkPlugin',
};

function setup() {
	const vfs = new VFS();
	vfs.mkdir('/data', { recursive: true });
	vfs.writeFile('/data/hello.txt', 'hello world');
	vfs.mkdir('/data/sub');
	vfs.mkdir('/data/many');
	// Enough names that the listing's JSON outgrows the thread's 64 KiB answer buffer.
	for (let i = 0; i < 3000; i++) vfs.writeFile(`/data/many/a-file-with-a-long-name-${i}.txt`, '');
	const fs = createFs(vfs, '/');
	const stdout: string[] = [];
	const stderr: string[] = [];
	const activity = createActivityTracker();
	const runtime = createNapiWasiRuntime({
		getFs: () => fs as unknown as Record<string, unknown>,
		env: { PROBE_ENV: 'from the box' },
		stdout: { write: (s) => stdout.push(s) },
		stderr: { write: (s) => stderr.push(s) },
		activity,
		readFile: (p) => {
			if (!(p in RUNTIME_FILES)) throw new Error(`no ${p}`);
			return RUNTIME_FILES[p];
		},
		exists: (p) => p in RUNTIME_FILES,
		resolve: (spec) => (spec === '@napi-rs/wasm-runtime' ? '/app/node_modules/@napi-rs/wasm-runtime/runtime.cjs' : null),
		compile: (source) => `(function (exports, require, module) {\n${source}\n})`,
		evaluate: (source) => {
			const module = { exports: {} as unknown };
			new Function('exports', 'require', 'module', source)(module.exports, () => { throw new Error('no require'); }, module);
			return module.exports;
		},
	});
	return { vfs, fs, stdout, stderr, activity, runtime };
}

describe('napi-wasi', () => {
	let runtime: NapiWasiRuntime | null = null;
	afterEach(() => {
		runtime?.dispose();
		runtime = null;
	});

	it('recognises napi-rs generated WASI loaders', () => {
		const loader = `const { WASI: __nodeWASI } = require('node:wasi')\nconst { Worker } = require('node:worker_threads')\nconst { instantiateNapiModuleSync } = require('@napi-rs/wasm-runtime')`;
		expect(isNapiWasiLoader(loader)).toBe(true);
		expect(isNapiWasiLoader(`const { WASI } = require("wasi"); require('@napi-rs/wasm-runtime')`)).toBe(true);
		expect(isNapiWasiLoader(`require('node:wasi')`)).toBe(false);
		expect(isNapiWasiLoader(`// mentions @napi-rs/wasm-runtime but loads nothing`)).toBe(false);
	});

	it("gives the loader a WASI on the box's fs", () => {
		const env = setup();
		runtime = env.runtime;
		let options: Record<string, unknown> | null = null;
		const loaderRequire = (id: string) => {
			expect(id).toBe('@napi-rs/wasm-runtime');
			return { WASI: function (o: Record<string, unknown>) { options = o; } };
		};
		const { wasi } = runtime.modulesFor('/app/node_modules/x-wasm32-wasi/x.wasi.cjs', loaderRequire);
		new (wasi as { WASI: new (o: unknown) => unknown }).WASI({ version: 'preview1', env: { A: '1' }, preopens: { '/': '/host' } });
		expect(options!.fs).toBe(env.fs);
		expect(options!.preopens).toEqual({ '/': '/' });
		expect(options!.env).toEqual({ A: '1' });
		(options!.print as (s: string) => void)('hi');
		expect(env.stdout.join('')).toBe('hi\n');
	});

	it("runs a thread that reaches the box's fs through the blocking channel", async () => {
		const env = setup();
		runtime = env.runtime;
		const { worker_threads } = runtime.modulesFor('/app/node_modules/x-wasm32-wasi/x.wasi.cjs', () => ({}));
		const Worker = (worker_threads as { Worker: new (f: string, o: unknown) => { on(e: string, fn: (d: unknown) => void): void; postMessage(m: unknown): void } }).Worker;
		const w = new Worker('/app/node_modules/x-wasm32-wasi/wasi-worker.mjs', {});
		const result = await new Promise<{ probe: string; out: Record<string, unknown>; env: string; preopens: unknown; message?: string }>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('the thread never answered')), 15000);
			w.on('message', (d) => {
				const data = d as { probe?: string };
				if (data.probe) {
					clearTimeout(timer);
					resolve(d as never);
				}
			});
			w.on('error', (e) => {
				clearTimeout(timer);
				reject(e);
			});
			w.postMessage({ __emnapi__: { type: 'load', payload: { wasmModule: null, wasmMemory: null } } });
		});
		expect(result.message).toBeUndefined();
		expect(result.probe).toBe('done');
		expect(result.out).toEqual({
			size: 'bigint:11',
			isFile: true,
			isDirectory: false,
			mtimeIsDate: true,
			dirents: ['hello.txt', 'many/', 'sub/'],
			missing: 'ENOENT',
			readShared: '5:hello',
			readPlain: '5:world',
			bigListing: 3000,
		});
		expect(result.env).toBe('from the box');
		expect(result.preopens).toEqual({ '/': '/' });
		expect(env.vfs.readFileString('/data/out.txt')).toBe('from a thread');
		expect(env.stdout.join('')).toContain('printed from wasm\n');
	});

	it('counts promise-returning addon calls as pending work', async () => {
		const env = setup();
		runtime = env.runtime;
		let finish: () => void = () => {};
		const pending = () => new Promise<void>((r) => { finish = r; });
		class BindingBundler {
			generate() { return pending(); }
			get name() { return 'b'; }
		}
		const exports = { parse: () => pending(), parseSync: () => 1, BindingBundler };
		runtime.trackExports(exports);
		expect(exports.parseSync()).toBe(1);
		expect(env.activity.pending()).toBe(0);
		const p1 = exports.parse();
		expect(env.activity.pending()).toBe(1);
		finish();
		await p1;
		await Promise.resolve();
		expect(env.activity.pending()).toBe(0);
		const bundler = new BindingBundler();
		expect(bundler).toBeInstanceOf(BindingBundler);
		const p2 = bundler.generate();
		expect(env.activity.pending()).toBe(1);
		finish();
		await p2;
		await Promise.resolve();
		expect(env.activity.pending()).toBe(0);
		expect(bundler.name).toBe('b');
	});
});

describe('a wasm addon the host cannot run', () => {
	const threadsError = () => Object.assign(new Error('[lifo] @rolldown/binding-wasm32-wasi needs WebAssembly threads, and no threads here'), { code: 'ERR_LIFO_WASM_THREADS' });

	it('is found anywhere in the cause chain napi-rs loaders build', () => {
		// napi-rs: new Error('Cannot find native binding. npm has a bug ...', { cause: loadErrors.reduce(...) })
		const native = new Error('Cannot find module ./rolldown-binding.darwin-arm64.node');
		const wasm = threadsError();
		(wasm as Error & { cause?: unknown }).cause = native;
		expect(isWasmThreadsUnavailable(new Error('Cannot find native binding.', { cause: wasm }))).toBe(true);
		expect(isWasmThreadsUnavailable(new Error('x', { cause: [native, wasm] }))).toBe(true);
		expect(isWasmThreadsUnavailable(new AggregateError([native, wasm]))).toBe(true);
		expect(isWasmThreadsUnavailable(new Error('Cannot find native binding.', { cause: native }))).toBe(false);
		// rolldown 1.3: createLoadErrorChain copies messages into fresh Errors, dropping the code.
		// ...after Lifo's module loader prefixed the failing file's path.
		const copied = new Error(`[/app/node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs] ${wasm.message}`, { cause: new Error(native.message) });
		expect(isWasmThreadsUnavailable(new Error('Cannot find native binding.', { cause: copied }))).toBe(true);
		const loop = new Error('a') as Error & { cause?: unknown };
		loop.cause = loop;
		expect(isWasmThreadsUnavailable(loop)).toBe(false);
	});

	it('ends the run with its one-line explanation, not the loader\'s error', async () => {
		const { default: node } = await import('../../src/commands/system/node.js');
		const vfs = new VFS();
		vfs.mkdir('/tmp');
		vfs.writeFile('/tmp/load.mjs', [
			`const wasm = new Error('[lifo] @rolldown/binding-wasm32-wasi needs WebAssembly threads, and this box runs on the page main thread');`,
			`throw new Error('Cannot find native binding. npm has a bug related to optional dependencies', { cause: wasm });`,
		].join('\n'));
		const out = { text: '', write(t: string) { this.text += t; } };
		const err = { text: '', write(t: string) { this.text += t; } };
		const code = await node({ args: ['/tmp/load.mjs'], env: {}, cwd: '/tmp', vfs, stdout: out, stderr: err, signal: new AbortController().signal });
		expect(code).toBe(1);
		expect(err.text).toBe('');
	});
});

describe('loaders that bundle their runtime', () => {
	// The shape of rolldown 1.3.4's rolldown-binding.wasi.cjs, cut down.
	const LOADER = [
		'var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);',
		'// ../../node_modules/.pnpm/@emnapi+runtime@2.0.0-beta.2/node_modules/@emnapi/runtime/index.cjs',
		'var require_runtime$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {',
		'\tmodule.exports.getDefaultContext = () => "ctx";',
		'}));',
		'// ../../node_modules/.pnpm/@napi-rs+wasm-runtime@1.2.6/node_modules/@napi-rs/wasm-runtime/runtime.cjs',
		'var require_runtime = /* @__PURE__ */ __commonJSMin(((exports, module) => {',
		'\tfunction WASI(o) { this.o = o; }',
		'\tmodule.exports = { MessageHandler: function () {}, instantiateNapiModuleSync: function () {}, WASI, getDefaultContext: require_runtime$1().getDefaultContext };',
		'}));',
		'// src/rolldown-binding.wasi.cjs',
		'const { WASI: __nodeWASI } = require("node:wasi");',
		'const { Worker } = require("node:worker_threads");',
		'const { instantiateNapiModuleSync: __emnapiInstantiateNapiModuleSync } = require_runtime();',
		'module.exports = {};',
	].join('\n');

	it('is recognised, and its runtime is cut out as a module of its own', () => {
		expect(isNapiWasiLoader(LOADER)).toBe(true);
		const src = embeddedRuntimeSource(LOADER)!;
		expect(src).not.toContain('require("node:wasi")');
		const module = { exports: {} as Record<string, unknown> };
		new Function('exports', 'module', src)(module.exports, module);
		expect(Object.keys(module.exports).sort()).toEqual(['MessageHandler', 'WASI', 'getDefaultContext', 'instantiateNapiModuleSync']);
		expect((module.exports.getDefaultContext as () => string)()).toBe('ctx');
	});

	it('is absent from loaders that require @napi-rs/wasm-runtime', () => {
		const old = `const { WASI } = require('node:wasi');\nconst { instantiateNapiModuleSync, getDefaultContext } = require('@napi-rs/wasm-runtime');\n`;
		expect(isNapiWasiLoader(old)).toBe(true);
		expect(embeddedRuntimeSource(old)).toBeNull();
	});
});
