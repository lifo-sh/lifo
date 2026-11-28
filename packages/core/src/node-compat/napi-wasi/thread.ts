/**
 * The script each WASI thread of a napi-rs wasm binding runs (see ./index.ts).
 *
 * A threaded napi-rs binding (`wasm32-wasip1-threads`) asks its loader for a new Worker for
 * every wasm thread. The package ships a `wasi-worker.mjs` for that, but it needs Node's
 * `fs`, `wasi` and `module` on the HOST, which would read the host's disk instead of the box.
 * Lifo runs this generic script instead. It does what that worker does, with three changes:
 *
 * - The napi-rs runtime (`@napi-rs/wasm-runtime`, `@emnapi/*`, `@tybys/wasm-util`) comes from
 *   the box: the main thread sends the package's own copies, already wrapped as CommonJS
 *   functions, so each binding runs with exactly the runtime version it was built against.
 * - WASI's filesystem is the box's. Every fs call is a blocking request to the thread that
 *   owns the VFS (a SharedArrayBuffer and Atomics.wait), answered by serveFsRequest.
 * - stdout/stderr from the wasm (a Rust panic, say) go to the box's terminal.
 *
 * It runs as a Node `worker_threads` eval script on a Node host, or as a classic Web Worker
 * from a Blob URL in a browser, and is serialized with Function#toString, so it must not
 * reference anything outside its own body (no imports, no TypeScript-only helpers).
 */
/* eslint-disable */
// @ts-nocheck -- plain ES5-ish JavaScript that runs in a fresh worker realm, not in this module.
export function napiWasiThread(): void {
	'use strict';
	var g = globalThis;
	var isNode =
		typeof process === 'object' && process !== null && !!process.versions && !!process.versions.node &&
		typeof require === 'function';
	var wt = isNode ? require('node:worker_threads') : null;
	var port = wt ? wt.parentPort : null;
	var post = function (msg) {
		if (port) port.postMessage(msg);
		else g.postMessage(msg);
	};

	// ── The box's fs, one blocking request at a time ──
	// Response layout (Int32 words): [0] status 0 pending, 1 ok, 2 threw, 3 too big;
	// [1] byte length; [2] token to fetch a too-big answer; bytes from offset 16 (JSON).
	function createFs(bufferSize) {
		var decoder = new TextDecoder();
		var sab = new SharedArrayBuffer(bufferSize);
		var words = new Int32Array(sab);

		function revive(_key, v) {
			if (!v || typeof v !== 'object' || typeof v.__lifo !== 'string') return v;
			switch (v.__lifo) {
				case 'bigint': return BigInt(v.v);
				case 'bytes': return new Uint8Array(v.v);
				case 'stat': return makeStat(v);
				case 'dirent': return makeDirent(v);
				case 'error': {
					var e = new Error(v.message);
					if (v.code !== undefined) e.code = v.code;
					if (v.errno !== undefined) e.errno = v.errno;
					if (v.syscall !== undefined) e.syscall = v.syscall;
					if (v.path !== undefined) e.path = v.path;
					return e;
				}
			}
			return v;
		}
		function kindFns(target, kind) {
			target.isFile = function () { return kind === 'file'; };
			target.isDirectory = function () { return kind === 'directory'; };
			target.isSymbolicLink = function () { return kind === 'symlink'; };
			target.isBlockDevice = function () { return false; };
			target.isCharacterDevice = function () { return false; };
			target.isFIFO = function () { return false; };
			target.isSocket = function () { return false; };
			return target;
		}
		function makeStat(v) {
			var s = {};
			for (var k in v) if (k !== '__lifo' && k !== 'kind') s[k] = v[k];
			['atime', 'mtime', 'ctime', 'birthtime'].forEach(function (t) {
				var ms = s[t + 'Ms'];
				if (ms !== undefined) s[t] = new Date(Number(ms));
			});
			return kindFns(s, v.kind);
		}
		function makeDirent(v) {
			return kindFns({ name: v.name, path: v.path, parentPath: v.path }, v.kind);
		}
		function readAnswer(buf, w) {
			var status = Atomics.load(w, 0);
			var len = Atomics.load(w, 1);
			// TextDecoder refuses views on shared memory, so copy out first.
			var text = len ? decoder.decode(new Uint8Array(buf, 16, len).slice()) : '';
			var value = text ? JSON.parse(text, revive) : undefined;
			if (status === 2) throw value;
			return value;
		}
		function request(method, args) {
			Atomics.store(words, 0, 0);
			post({ __lifo_fs__: { sab: sab, method: method, args: args } });
			Atomics.wait(words, 0, 0);
			if (Atomics.load(words, 0) !== 3) return readAnswer(sab, words);
			// The answer didn't fit: fetch it into a buffer of the size the main thread asked for.
			// (rounded up to whole Int32 words, which the header view needs)
			var big = new SharedArrayBuffer(16 + ((Atomics.load(words, 1) + 3) & ~3));
			var bigWords = new Int32Array(big);
			post({ __lifo_fs__: { sab: big, fetch: Atomics.load(words, 2) } });
			Atomics.wait(bigWords, 0, 0);
			return readAnswer(big, bigWords);
		}

		var fs = {};
		[
			'accessSync', 'chmodSync', 'closeSync', 'copyFileSync', 'existsSync', 'fchmodSync', 'fdatasyncSync',
			'fstatSync', 'fsyncSync', 'ftruncateSync', 'futimesSync', 'linkSync', 'lstatSync', 'lutimesSync',
			'mkdirSync', 'openSync', 'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync', 'renameSync',
			'rmdirSync', 'rmSync', 'statSync', 'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync',
			'writeFileSync', 'writeSync',
		].forEach(function (name) {
			fs[name] = function () { return request(name, Array.prototype.slice.call(arguments)); };
		});
		// readSync fills the caller's buffer. A view on the shared wasm memory travels by
		// reference, so the main thread writes straight into it; anything else is read into a
		// shared scratch buffer and copied.
		fs.readSync = function (fd, buffer, offset, length, position) {
			if (offset && typeof offset === 'object') {
				position = offset.position;
				length = offset.length;
				offset = offset.offset;
			}
			offset = offset || 0;
			if (length === undefined) length = buffer.byteLength - offset;
			if (position === undefined) position = null;
			if (buffer.buffer instanceof SharedArrayBuffer) return request('readSync', [fd, buffer, offset, length, position]);
			var scratch = new Uint8Array(new SharedArrayBuffer(Math.max(length, 1)));
			var n = request('readSync', [fd, scratch, 0, length, position]);
			new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(scratch.subarray(0, n), offset);
			return n;
		};
		return fs;
	}

	// ── CommonJS over the modules the main thread sent ──
	function createLoader(modules) {
		var cache = {};
		// Node threads have setImmediate; a browser Worker doesn't.
		var setImmediateFn = typeof setImmediate === 'function' ? setImmediate : function (fn) {
			var args = Array.prototype.slice.call(arguments, 1);
			return setTimeout(function () { fn.apply(null, args); }, 0);
		};
		var clearImmediateFn = typeof clearImmediate === 'function' ? clearImmediate : clearTimeout;
		function dirOf(p) {
			var i = p.lastIndexOf('/');
			return i <= 0 ? '/' : p.slice(0, i);
		}
		// A Node eval worker puts its require on globalThis. Reading it from there keeps this
		// lookup by name out of sight of bundlers that parse this function inside the library
		// (Next's Turbopack fails the build on a require() of a computed name).
		var nodeRequire = isNode ? g.require : null;
		function builtin(name) {
			if (nodeRequire) return nodeRequire(name.indexOf('node:') === 0 ? name : 'node:' + name);
			throw new Error("Cannot find module '" + name + "' (not available in a WASI thread)");
		}
		function load(path) {
			if (cache[path]) return cache[path].exports;
			var m = modules[path];
			if (!m) throw new Error("Cannot find module '" + path + "'");
			var module = { exports: {} };
			cache[path] = module;
			if (m.json !== undefined) {
				module.exports = m.json;
				return module.exports;
			}
			var fn = (0, eval)(m.code + '\n//# sourceURL=lifo-wasi-thread://' + path);
			var req = function (spec) {
				var target = Object.prototype.hasOwnProperty.call(m.deps, spec) ? m.deps[spec] : undefined;
				if (typeof target === 'string') return target.indexOf('builtin:') === 0 ? builtin(target.slice(8)) : load(target);
				// null: the main thread looked and found nothing; undefined: not a literal require.
				if (target === null) throw new Error("Cannot find module '" + spec + "' from '" + path + "'");
				return builtin(spec);
			};
			var url = 'file://' + path;
			// Same parameters, in the same order, as the box's module wrapper (node.ts).
			fn.call(
				module.exports,
				module.exports, req, module, path, dirOf(path),
				console, isNode ? process : undefined, g.Buffer,
				setTimeout, setInterval, clearTimeout, clearInterval, g,
				url, { url: url, filename: path, dirname: dirOf(path) },
				function () { throw new Error('import.meta.resolve is not supported in a WASI thread'); },
				undefined, undefined, g.self, g.navigator, g.fetch,
				setImmediateFn, clearImmediateFn,
			);
			return module.exports;
		}
		return load;
	}

	function start(init) {
		var rt = createLoader(init.modules)(init.runtime);
		var fs = createFs(init.fsBufferSize || 65536);
		var printer = function (fd) {
			return function () {
				post({ __lifo_stdio__: { fd: fd, text: Array.prototype.map.call(arguments, String).join(' ') + '\n' } });
			};
		};
		var crash = init.crash || {};
		var raiseCrashFlags = function () {
			try { if (crash.crashFlag instanceof Int32Array) Atomics.store(crash.crashFlag, 0, 1); } catch (e) {}
			try { if (crash.addonCrashFlag instanceof Int32Array) Atomics.store(crash.addonCrashFlag, 0, 1); } catch (e) {}
		};

		// emnapi's thread code expects `self`. A browser Worker has it (a getter that can't be
		// assigned); a Node thread doesn't.
		if (g.self !== g) g.self = g;
		if (port) g.postMessage = function (msg) { port.postMessage(msg); };

		var handler = new rt.MessageHandler({
			onLoad: function (o) {
				var wasi = new rt.WASI({
					version: 'preview1',
					args: [],
					env: init.env || {},
					preopens: { '/': '/' },
					fs: fs,
					print: printer(1),
					printErr: printer(2),
				});
				var options = {
					childThread: true,
					wasi: wasi,
					overwriteImports: function (io) {
						io.env = Object.assign({}, io.env, io.napi, io.emnapi, { memory: o.wasmMemory });
						return io;
					},
				};
				if (typeof rt.getDefaultContext === 'function') options.context = rt.getDefaultContext();
				// Bindings that link emnapi's "basic" archive need the JS async-work and
				// threadsafe-function plugins on every thread (their own worker script passes them).
				if (init.plugins && rt.emnapiAsyncWorkPlugin && rt.emnapiTSFNPlugin) {
					options.plugins = [rt.emnapiAsyncWorkPlugin, rt.emnapiTSFNPlugin];
				}
				return rt.instantiateNapiModuleSync(o.wasmModule, options);
			},
		});
		var beforeReportError = handler.beforeReportError;
		handler.beforeReportError = function () {
			raiseCrashFlags();
			return typeof beforeReportError === 'function' ? beforeReportError.apply(this, arguments) : undefined;
		};
		g.onmessage = function (e) {
			var data = e && e.data;
			if (data && data.__napiRsAddonCrashFlag instanceof Int32Array) {
				crash.addonCrashFlag = data.__napiRsAddonCrashFlag;
				return;
			}
			handler.handle(e);
		};
	}

	if (port) {
		port.on('message', function (data) {
			if (g.onmessage) g.onmessage({ data: data });
		});
		try {
			start(wt.workerData);
		} catch (err) {
			post({ __lifo_thread_error__: { message: String(err && err.stack || err) } });
			throw err;
		}
	} else {
		// Browser: the first message carries what workerData does on Node.
		g.onmessage = function (e) {
			var init = e && e.data && e.data.__lifo_init__;
			if (!init) return;
			try {
				start(init);
			} catch (err) {
				post({ __lifo_thread_error__: { message: String(err && err.stack || err) } });
				throw err;
			}
		};
	}
}

/** The thread script as source text, ready for `new Worker(…, { eval: true })` or a Blob URL. */
export const NAPI_WASI_THREAD_SOURCE = `(${napiWasiThread.toString()})();\n`;
