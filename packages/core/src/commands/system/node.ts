import type { Command } from '../types.js';
import { resolve, dirname, join, extname } from '../../utils/path.js';
import { createModuleMap, ProcessExitError } from '../../node-compat/index.js';
import type { NodeContext } from '../../node-compat/index.js';
import { createProcess, createInteractiveStdin } from '../../node-compat/process.js';
import { createModuleClass } from '../../node-compat/module.js';

/**
 * Build the `global` object handed to executed modules. Real Node's `global`
 * exposes every JS built-in (Math, Number, String, JSON, Object, Array, ...);
 * babel's constant-evaluator does `context = global[calleeName]` then
 * `hasOwnProperty.call(context, key)` when folding calls like `Math.pow(...)`,
 * so a bare `{process, Buffer, console}` makes it throw "Cannot convert
 * undefined or null to object". Inherit from globalThis so the built-ins
 * resolve, layer the Node shims as own props, and self-reference (in Node,
 * `global.global === global`).
 */
function makeNodeGlobal(overrides: Record<string, unknown>): Record<string, unknown> {
	// Proxy, not Object.create(globalThis): assignments like
	// `global.JIMPBUffer = X` (jimp-compact) must land on the REAL globalThis,
	// because other modules then reference the bare identifier `JIMPBUffer`,
	// which resolves through the scope chain to globalThis — a prototype-child
	// would swallow the write and leave the bare lookup dangling
	// (ReferenceError). The overlay keys (process/Buffer/console/global) stay
	// per-module so each run keeps its own Node shims.
	const own: Record<string, unknown> = { ...overrides };
	const g = new Proxy(own, {
		get(t, k) {
			if (k in t) return t[k as string];
			return (globalThis as unknown as Record<string | symbol, unknown>)[k];
		},
		set(t, k, v) {
			if (k in t) t[k as string] = v;
			else (globalThis as unknown as Record<string | symbol, unknown>)[k] = v;
			return true;
		},
		has(t, k) {
			return k in t || k in (globalThis as object);
		},
		getOwnPropertyDescriptor(t, k) {
			const d = Object.getOwnPropertyDescriptor(t, k) ?? Object.getOwnPropertyDescriptor(globalThis, k);
			if (d) d.configurable = true; // proxy invariant: target may not own it
			return d;
		},
		ownKeys(t) {
			return Array.from(new Set([...Reflect.ownKeys(t), ...Reflect.ownKeys(globalThis as object)]));
		},
		defineProperty(t, k, desc) {
			if (k in t) Object.defineProperty(t, k, desc);
			else Object.defineProperty(globalThis, k, desc);
			return true;
		},
		deleteProperty(t, k) {
			if (k in t) delete t[k as string];
			else delete (globalThis as unknown as Record<string | symbol, unknown>)[k];
			return true;
		},
	}) as unknown as Record<string, unknown>;
	own.global = g;
	return g;
}

import { makeProxyingFetch } from '../../node-compat/proxy-fetch.js';
import * as nodeTimers from '../../node-compat/timers.js';

/**
 * Native-backed stand-in for the `fetch-nodeshim` package. minifetch ships its
 * own http/https-based fetch for old Node; in the VM the NATIVE fetch stack is
 * strictly better (real web streams and Response objects), and our
 * CORS-proxying fetch handles the hosts a browser can't reach directly.
 * Serving this instead of letting minifetch run over our http shims removes a
 * whole class of impedance bugs (setHeader, stream duck-typing, gzip).
 *
 * One critical adaptation: expo's response cache constructs
 * `new Response(fs.createReadStream(...))` — a NODE stream, which the native
 * Response coerces to the literal string "[object Object]" (surfacing as
 * SyntaxError: "[object Object]" is not valid JSON, killing `expo start`).
 * The Response subclass converts node-style streams to web streams first.
 */
function makeFetchNodeshim(fetchImpl: typeof fetch): Record<string, unknown> {
	const g = globalThis as unknown as Record<string, unknown>;
	type NodeishStream = { on: (ev: string, fn: (...a: unknown[]) => void) => unknown; getReader?: unknown };
	const nodeStreamToWeb = (s: NodeishStream): ReadableStream =>
		new ReadableStream({
			start(controller) {
				s.on('data', (chunk: unknown) => {
					try {
						controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : (chunk as Uint8Array));
					} catch { /* closed */ }
				});
				s.on('end', () => { try { controller.close(); } catch { /* closed */ } });
				s.on('error', (e: unknown) => { try { controller.error(e); } catch { /* closed */ } });
			},
		});
	const NativeResponse = g.Response as typeof Response;
	class ShimResponse extends NativeResponse {
		constructor(body?: unknown, init?: ResponseInit) {
			const b = body as NodeishStream | null | undefined;
			if (b && typeof b === 'object' && typeof b.on === 'function' && !(b instanceof Uint8Array) && typeof b.getReader !== 'function') {
				body = nodeStreamToWeb(b);
			}
			super(body as BodyInit | null, init);
		}
	}
	return {
		fetch: fetchImpl,
		default: fetchImpl,
		Response: ShimResponse,
		Request: g.Request,
		Headers: g.Headers,
		FormData: g.FormData,
		Blob: g.Blob,
		URL: g.URL,
		URLSearchParams: g.URLSearchParams,
	};
}
import { createConsole } from '../../node-compat/console.js';
import { Buffer } from '../../node-compat/buffer.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { createRollupParseShim } from '../../node-compat/rollup-parse.js';
import { wrapBabelSync } from '../../node-compat/babel-sync.js';
import { ACTIVE_SERVERS } from '../../node-compat/http.js';
import type { VirtualRequestHandler, Kernel } from '../../kernel/index.js';

const NODE_VERSION = 'v20.0.0';

// Node 21+ exposes a global `navigator` whose userAgent is "Node.js/<ver>".
// Executed modules must see THAT, not the browser's — expo-constants'
// getBrowserName sees a Chrome userAgent and then dereferences `window`
// (undefined in the node context): "Cannot use 'in' operator ... in undefined",
// killing expo-router SSR. Injected as a wrapper param so bare `navigator`
// references shadow the page's real navigator.
const NODE_NAVIGATOR = Object.freeze({
	userAgent: `Node.js/${NODE_VERSION.slice(1)}`,
	platform: 'lifo',
	language: 'en-US',
	languages: Object.freeze(['en-US']),
	hardwareConcurrency: 1,
});

// ── Rollup / esbuild CJS-ESM interop helpers ──
// Bundled npm packages (Vite, Rollup, etc.) reference these helpers at the module
// scope.  When our ESM→CJS transform converts imports, the helpers may lose their
// binding.  Making them available on globalThis acts as a fallback – if the module
// defines its own copy the local declaration naturally shadows the global.
//
// Complete set from @rollup/plugin-commonjs interop:
const _rollupHelpers: Record<string, (...args: unknown[]) => unknown> = {
	getDefaultExportFromCjs(x: unknown): unknown {
		const o = x as Record<string, unknown>;
		return o && o.__esModule && Object.prototype.hasOwnProperty.call(o, 'default') ? o.default : o;
	},
	getDefaultExportFromNamespaceIfPresent(n: unknown): unknown {
		const o = n as Record<string, unknown>;
		return o && Object.prototype.hasOwnProperty.call(o, 'default') && Object.keys(o).length === 1 ? o.default : o;
	},
	getAugmentedNamespace(n: unknown): unknown {
		const o = n as Record<string, unknown>;
		if (o.__esModule) return o;
		const a: Record<string, unknown> = Object.defineProperty({}, '__esModule', { value: true });
		Object.keys(o).forEach(function (k) {
			const d = Object.getOwnPropertyDescriptor(o, k);
			Object.defineProperty(a, k, d && d.get ? d : { enumerable: true, get() { return o[k]; } });
		});
		a.default = n;
		return Object.freeze(a);
	},
	_mergeNamespaces(n: unknown, ...ms: unknown[]): unknown {
		const o = n as Record<string, unknown>;
		const modules = ms.flat() as Array<Record<string, unknown>>;
		for (const m of modules) {
			for (const k of Object.keys(m)) {
				if (k !== 'default' && !(k in o)) {
					Object.defineProperty(o, k, { enumerable: true, get: () => m[k] });
				}
			}
		}
		return Object.freeze(o);
	},
};

/** Strip shebang line (e.g. #!/usr/bin/env node) – replace with blank to preserve line numbers */
function stripShebang(src: string): string {
	if (src.charCodeAt(0) === 0x23 /* # */ && src.charCodeAt(1) === 0x21 /* ! */) {
		const nl = src.indexOf('\n');
		if (nl === -1) return '';
		return '\n' + src.slice(nl + 1);
	}
	return src;
}

/** Check if source contains ESM import/export syntax */
function isEsmSource(source: string): boolean {
	// Mask strings/comments first so example import/export syntax inside them
	// (common in babel plugin sources) doesn't misflag a CJS file as ESM.
	const { masked } = maskStringLiterals(source);
	// Match import/export at line start, after semicolon, or minified (import{, import*)
	return /(?:^|\n|;)\s*(?:import\s*[\w{*('".]|export\s+|export\s*\{)/.test(masked);
}

/** Determine if source should be treated as ESM based on filename, content, and package.json type */
function shouldTreatAsEsm(source: string, filename: string, vfs?: { exists(p: string): boolean; readFileString(p: string): string }): boolean {
	const ext = extname(filename);
	if (ext === '.mjs') return true;
	if (ext === '.cjs') return false;
	// Check nearest package.json "type" field (Node.js semantics)
	if (vfs && ext === '.js') {
		let dir = dirname(filename);
		for (; ;) {
			const pkgPath = join(dir, 'package.json');
			if (vfs.exists(pkgPath)) {
				try {
					const pkg = JSON.parse(vfs.readFileString(pkgPath));
					if (pkg.type === 'module') return true;
					if (pkg.type === 'commonjs') return false;
				} catch { /* ignore */ }
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return isEsmSource(source);
}

// Names that collide with the new Function() CJS wrapper parameters.
// Using `const` for these would throw "Identifier X has already been declared",
// so we emit `var` instead (var can shadow function params in non-strict mode).
const CJS_WRAPPER_PARAMS = new Set([
	'exports', 'require', 'module', '__filename', '__dirname',
	'console', 'process', 'Buffer', 'setTimeout', 'setInterval',
	'clearTimeout', 'clearInterval', 'global',
	'__importMetaUrl', '__importMeta', '__importMetaResolve',
]);
function cjsDecl(name: string): string {
	return CJS_WRAPPER_PARAMS.has(name) ? 'var' : 'const';
}

/**
 * Classify whether the '/' at position i starts a regex literal.
 * - 'strong': preceded by an operator or keyword — reliably a regex.
 * - 'weak': preceded by ')', ']' or '}' — could be division. Callers must
 *   validate the scanned candidate with isPlausibleRegex(); in minified
 *   single-line code a mis-detected division swallows everything up to the
 *   next '/' (there is no newline to stop at) and desyncs string masking.
 * Under-detection is also dangerous (a backtick inside an undetected regex
 * triggers the template parser), hence scan-then-validate instead of
 * dropping the weak preceders.
 */
function isRegexStart(src: string, i: number): 'strong' | 'weak' | false {
	let k = i - 1;
	while (k >= 0 && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k--;
	const prev = k >= 0 ? src[k] : '\0';
	if ('\0=([{,;!&|^~?:+-*%<>/'.includes(prev) ||
		(k >= 1 && /\b(?:return|typeof|void|delete|throw|new|case|of|in|yield|await)\s*$/.test(src.slice(Math.max(0, k - 11), k + 1)))) {
		return 'strong';
	}
	if (')]}'.includes(prev)) return 'weak';
	return false;
}

/** Sanity check for a scanned regex candidate (leading slash..trailing slash+flags). */
function isPlausibleRegex(candidate: string): boolean {
	const lastSlash = candidate.lastIndexOf('/');
	if (lastSlash <= 0) return false;
	const body = candidate.slice(1, lastSlash);
	if (body.length === 0 || body.length > 500 || body.includes('\n')) return false;
	try {
		new RegExp(body);
		return true;
	} catch {
		return false;
	}
}

/** Scan a regex literal starting at i ('/'); returns the index just past it. */
function scanRegexLiteral(src: string, i: number): number {
	i++; // skip opening /
	while (i < src.length && src[i] !== '\n') {
		if (src[i] === '\\') { i += 2; continue; }
		if (src[i] === '/') { i++; break; }
		if (src[i] === '[') { // character class — / doesn't end regex inside [...]
			i++;
			while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
				if (src[i] === '\\') i++;
				i++;
			}
			if (i < src.length && src[i] === ']') i++;
			continue;
		}
		i++;
	}
	while (i < src.length && /[gimsuyv]/.test(src[i])) i++; // flags
	return i;
}

/** Scan a '...' or "..." literal starting at i (the quote); returns the index just past the closing quote. */
function scanQuoteLiteral(src: string, i: number): number {
	const quote = src[i];
	i++;
	while (i < src.length) {
		if (src[i] === '\\') { i += 2; continue; }
		if (src[i] === quote) { i++; break; }
		i++;
	}
	return i;
}

/** Scan a template literal starting at i (backtick); returns the index just past the closing backtick. */
function scanTemplateLiteral(src: string, i: number): number {
	i++;
	while (i < src.length) {
		if (src[i] === '\\') { i += 2; continue; }
		if (src[i] === '`') { i++; break; }
		if (src[i] === '$' && i + 1 < src.length && src[i + 1] === '{') {
			i = scanBracedExpr(src, i + 2);
			continue;
		}
		i++;
	}
	return i;
}

/**
 * Scan a ${...} expression body starting just after '${'; returns the index
 * just past the matching '}'. Brace depth must ignore braces inside comments,
 * strings, nested templates, and regex literals (e.g. /^[{[]/ in an
 * expression would otherwise desync the depth and swallow the file).
 */
function scanBracedExpr(src: string, i: number): number {
	let depth = 1;
	while (i < src.length && depth > 0) {
		const c = src[i];
		if (c === '/' && i + 1 < src.length && src[i + 1] === '/') {
			const nl = src.indexOf('\n', i);
			i = nl === -1 ? src.length : nl;
			continue;
		}
		if (c === '/' && i + 1 < src.length && src[i + 1] === '*') {
			const end = src.indexOf('*/', i + 2);
			i = end === -1 ? src.length : end + 2;
			continue;
		}
		if (c === '/') {
			const kind = isRegexStart(src, i);
			if (kind) {
				const end = scanRegexLiteral(src, i);
				if (kind === 'strong' || isPlausibleRegex(src.slice(i, end))) { i = end; continue; }
			}
		}
		if (c === "'" || c === '"') { i = scanQuoteLiteral(src, i); continue; }
		if (c === '`') { i = scanTemplateLiteral(src, i); continue; }
		if (c === '{') depth++;
		else if (c === '}') depth--;
		i++;
	}
	return i;
}

/**
 * Mask string/template literals with safe placeholders so that
 * import/export regexes don't match keywords inside string content.
 * Returns the masked source and an array of original literals for restoration.
 */
function maskStringLiterals(src: string): { masked: string; literals: string[] } {
	const literals: string[] = [];
	let masked = '';
	let i = 0;

	while (i < src.length) {
		const ch = src[i];

		// Single-line comments — mask so ESM regexes don't match example code
		// inside them (e.g. babel-preset-expo's `// export { foo as default }`).
		if (ch === '/' && i + 1 < src.length && src[i + 1] === '/') {
			const nl = src.indexOf('\n', i);
			const end = nl === -1 ? src.length : nl;
			const idx = literals.length;
			literals.push(src.slice(i, end));
			masked += '/*__LIFO_C' + idx + '__*/';
			i = end;
			continue;
		}
		// Multi-line comments — mask likewise
		if (ch === '/' && i + 1 < src.length && src[i + 1] === '*') {
			const end = src.indexOf('*/', i + 2);
			const close = end === -1 ? src.length : end + 2;
			const idx = literals.length;
			literals.push(src.slice(i, close));
			masked += '/*__LIFO_C' + idx + '__*/';
			i = close;
			continue;
		}

		// Regex literals — skip to avoid confusing backticks inside /regex/ with templates
		if (ch === '/') {
			const kind = isRegexStart(src, i);
			if (kind) {
				const end = scanRegexLiteral(src, i);
				if (kind === 'strong' || isPlausibleRegex(src.slice(i, end))) {
					masked += src.slice(i, end);
					i = end;
					continue;
				}
			}
		}

		// String/template literals
		if (ch === '"' || ch === "'" || ch === '`') {
			const start = i;
			i = ch === '`' ? scanTemplateLiteral(src, i) : scanQuoteLiteral(src, i);

			const literal = src.slice(start, i);
			const idx = literals.length;
			literals.push(literal);

			// Placeholder uses same quote style so import regexes that capture
			// ['"][^'"]+['"] still work (they see e.g. "__LIFO_S0__").
			masked += ch + '__LIFO_S' + idx + '__' + ch;
			continue;
		}

		masked += ch;
		i++;
	}

	return { masked, literals };
}

/** import.meta → CJS-wrapper identifier replacements (plain text, ordered). */
function replaceImportMeta(code: string): string {
	return code
		.split('import.meta.url').join('__importMetaUrl')
		.split('import.meta.dirname').join('__dirname')
		.split('import.meta.filename').join('__filename')
		.split('import.meta.require').join('require')
		.split('import.meta.resolve').join('__importMetaResolve')
		// Bare import.meta (catch-all, must come AFTER specific property replacements)
		.split('import.meta').join('__importMeta');
}

/**
 * Apply import.meta replacements inside the ${...} expression spans of a
 * template literal. Expressions are code and must be transformed; the static
 * text chunks are left untouched — they may be client-facing source (e.g.
 * Vite emitting `import.meta.hot.accept()` into served modules) that must
 * keep `import.meta` intact.
 */
function replaceImportMetaInTemplateExprs(template: string): string {
	let out = '';
	let i = 0;
	while (i < template.length) {
		const ch = template[i];
		if (ch === '\\') { out += template.slice(i, i + 2); i += 2; continue; }
		if (ch === '$' && template[i + 1] === '{') {
			const end = scanBracedExpr(template, i + 2);
			const expr = template.slice(i + 2, end - 1);
			out += '${' + replaceImportMetaSafely(expr) + '}';
			i = end;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Apply import.meta replacements to a code fragment while leaving string
 * literal contents untouched (template ${...} expressions are recursed into).
 */
function replaceImportMetaSafely(code: string): string {
	const { masked, literals } = maskStringLiterals(code);
	const replaced = replaceImportMeta(masked);
	for (let i = 0; i < literals.length; i++) {
		if (literals[i].startsWith('`')) {
			literals[i] = replaceImportMetaInTemplateExprs(literals[i]);
		}
	}
	return unmaskStringLiterals(replaced, literals);
}

/**
 * Restore original string/template literals from masked placeholders.
 */
function unmaskStringLiterals(src: string, literals: string[]): string {
	return src
		.replace(
			/(['"`])__LIFO_S(\d+)__\1/g,
			(_match, _quote, idxStr) => literals[parseInt(idxStr, 10)]
		)
		.replace(
			/\/\*__LIFO_C(\d+)__\*\//g,
			(_match, idxStr) => literals[parseInt(idxStr, 10)]
		);
}

/**
 * Rewrite dynamic import() calls to __lifoRequire on ALREADY string/comment-masked
 * source. The browser's native import() cannot resolve bare Node specifiers like
 * 'fs/promises' (e.g. pglite's CJS bundle does `await import('fs/promises')`), so
 * every dynamic import must route through our require. Uses __lifoRequire because
 * modules may shadow `require` inside a factory scope.
 */
function rewriteDynamicImportsMasked(result: string): string {
	// Dynamic import() with a string-literal specifier.
	result = result.replace(
		/(?<!\.)(?<!\w)\bimport\s*\(\s*(['"][^'"]+['"])\s*\)/g,
		(_match, mod) => `Promise.resolve(__lifoRequire(${mod}))`
	);

	// Dynamic import() with any expression (variables, templates, nested parens).
	// Programmatic paren-balancing since regex can't handle nested parens.
	let i = 0;
	let out = '';
	while (i < result.length) {
		const importIdx = result.indexOf('import(', i);
		if (importIdx === -1) { out += result.slice(i); break; }
		// char before 'import' must not be [\w$.] (dot = method call)
		if (importIdx > 0 && /[\w$.]/.test(result[importIdx - 1])) {
			out += result.slice(i, importIdx + 7);
			i = importIdx + 7;
			continue;
		}
		// Skip method definitions like `async import(url) {` (a `{` follows the `)`).
		{
			let depth = 1;
			let k = importIdx + 7;
			while (k < result.length && depth > 0) {
				if (result[k] === '(') depth++;
				else if (result[k] === ')') depth--;
				k++;
			}
			if (depth === 0) {
				let afterClose = k;
				while (afterClose < result.length && /[ \t]/.test(result[afterClose])) afterClose++;
				if (result[afterClose] === '{') {
					out += result.slice(i, importIdx + 7);
					i = importIdx + 7;
					continue;
				}
			}
		}
		out += result.slice(i, importIdx);
		let depth = 1;
		let j = importIdx + 7;
		while (j < result.length && depth > 0) {
			if (result[j] === '(') depth++;
			else if (result[j] === ')') depth--;
			j++;
		}
		if (depth === 0) {
			const arg = result.slice(importIdx + 7, j - 1);
			out += `Promise.resolve().then(function() { return __lifoRequire(${arg}); })`;
		} else {
			out += result.slice(importIdx, j);
		}
		i = j;
	}
	return out;
}

/** Mask strings/comments, rewrite dynamic import(), unmask. For CJS modules that skip transformEsmToCjs. */
function rewriteDynamicImports(source: string): string {
	if (!source.includes('import(')) return source;
	const { masked, literals } = maskStringLiterals(source);
	let result = unmaskStringLiterals(rewriteDynamicImportsMasked(masked), literals);
	// Stable require alias captured at wrapper scope before any module-level
	// `var require` shadow can hoist over it.
	if (result.includes('__lifoRequire(')) {
		// Node's dynamic import() of a CJS module exposes module.exports as the
		// namespace `.default`. Our import() maps to require(), so add that interop
		// (e.g. @expo/metro-config does `(await import('browserslist')).default(...)`
		// — browserslist is `module.exports = fn`, so without a `.default` it throws
		// "browserslist.default is not a function"). Non-enumerable + only when
		// absent, so it's invisible to spreads and leaves ESM modules untouched.
		result = 'var __lifoRequire = function (id) { var m = require(id); if (m != null && !m.__esModule && (typeof m === "object" || typeof m === "function") && !("default" in m)) { try { Object.defineProperty(m, "default", { value: m, configurable: true }); } catch (e) {} } return m; };\n' + result;
	}
	return result;
}

/**
 * Build the CJS wrapper parameter list for a module. Injected globals whose
 * name the module itself declares at top level (class/let/const) must be
 * renamed — a like-named parameter would be a SyntaxError (e.g.
 * @babel/generator declares `class Buffer`). The module's own declaration
 * then wins; positional arguments are unaffected.
 */
const SHADOWABLE_WRAPPER_PARAMS = ['console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'global', 'window', 'document', 'self', 'navigator', 'fetch'];

function buildWrapperParams(source: string): string {
	const params = ['exports', 'require', 'module', '__filename', '__dirname', 'console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'global', '__importMetaUrl', '__importMeta', '__importMetaResolve', 'window', 'document', 'self', 'navigator', 'fetch'];
	return params.map((p) => {
		if (!SHADOWABLE_WRAPPER_PARAMS.includes(p)) return p;
		// Direct declaration, e.g. `const Buffer = ...` / `class Buffer {}`.
		// COLUMN 0 only: indented declarations are function-scoped (legal next to
		// a like-named param) — a Metro SSR bundle contains an indented
		// `const navigator` inside one of its thousands of modules, and renaming
		// the wrapper param un-shadowed `navigator` for the WHOLE bundle (bare
		// references then hit the browser's real navigator → expo-constants'
		// getBrowserName saw a Chrome UA and crashed on `'chrome' in window`).
		// Only a TOP-LEVEL redeclaration is a SyntaxError worth renaming for.
		const direct = new RegExp(`(?:^|\\n)(?:class|let|const)\\s+${p}\\b`);
		// Destructuring declaration, e.g. `const { Buffer } = require('node:buffer')` (undici).
		// A const/let re-binding a wrapper param name is a SyntaxError, so rename the param.
		const destructured = new RegExp(`(?:^|\\n)(?:let|const)\\s*\\{[^{}]*\\b${p}\\b[^{}]*\\}`);
		return direct.test(source) || destructured.test(source) ? `__lifo_shadowed_${p}` : p;
	}).join(', ');
}

/** Transform ESM import/export syntax to CJS require/exports equivalents */
// Exported for tests and debugging.
export function transformEsmToCjs(source: string): string {
	// Normalize \r\n → \n so regexes anchored on \n work with Windows line endings
	let result = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	// Mask string/template literal contents so import/export regexes don't
	// match keywords inside strings (e.g. const HELPERS = `export function ...`)
	const { masked, literals } = maskStringLiterals(result);

	result = masked;

	// import.meta.* replacements run on the MASKED source: string literal
	// contents must survive untouched. Code that builds client-facing source
	// out of strings (e.g. Vite emitting `import.meta.hot.accept()` into
	// served modules) would otherwise ship broken `__importMeta` references
	// to the browser. A masker miss would leave `import.meta` behind and
	// fail the CJS wrapper at parse time — if that resurfaces, fix the
	// masker rather than moving these back before masking.
	result = replaceImportMeta(result);
	// Template literal ${...} expressions are code too, but they were masked
	// away with their literal — transform them inside the stored literals.
	for (let li = 0; li < literals.length; li++) {
		if (literals[li].startsWith('`')) {
			literals[li] = replaceImportMetaInTemplateExprs(literals[li]);
		}
	}
	// Split semicolon-separated import/export onto their own lines
	// so that the (?:^|\n) anchored regexes below can find them in minified code
	result = result.replace(
		/;([ \t]*(?:import\s*[\w${*('".]|export[\s{*]))/g,
		';\n$1'
	);
	// Same for a closing brace directly followed by import/export (ASI in
	// minified bundles, e.g. Emscripten output: `...}export{a as b};`).
	// Runs on masked source, so string contents can't false-positive.
	result = result.replace(
		/\}([ \t]*(?:import\s*[\w${*('".]|export[\s{*]))/g,
		'}\n$1'
	);
	const trailingExports: string[] = [];
	let hasDefaultExport = false;
	let hasNamedExport = false;
	// Track import sources: localName → { modRef, prop } for live-binding exports
	const importSources = new Map<string, { modRef: string; prop: string }>();

	// Scan for export types to decide default export strategy
	hasDefaultExport = /(?:^|\n)\s*export\s+default\s+/.test(result);
	hasNamedExport = /(?:^|\n)\s*export\s+(?:const|let|var|function|class|\{|\*\s+from)/.test(result);

	// --- Import transforms ---
	// NOTE: JS identifiers can contain $ (e.g. fs$8, path$b in esbuild bundles).
	// We use [\w$]+ instead of \w+ throughout to match these correctly.

	// Combined: import X, { a, b as c } from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(match, indent, defaultName, imports, mod) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (imports.includes('${')) return match;
			const tmp = '__mod_' + defaultName;
			const mapped = imports.split(',').map((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const sourceProp = parts[0].trim();
				const localName = parts.length === 2 ? parts[1].trim() : sourceProp;
				if (localName) importSources.set(localName, { modRef: tmp, prop: sourceProp });
				if (parts.length === 2) return `${sourceProp}: ${localName}`;
				return sourceProp;
			}).filter((s: string) => s).join(', ');
			return `\n${indent}${cjsDecl(tmp)} ${tmp} = require(${mod});\n${indent}${cjsDecl(defaultName)} ${defaultName} = ${tmp}.default || ${tmp};\n${indent}const { ${mapped} } = ${tmp};`;
		}
	);

	// Combined: import X, * as Y from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s+([\w$]+)\s*,\s*\*\s*as\s+([\w$]+)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, defaultName, nsName, mod) => {
			return `\n${indent}${cjsDecl(nsName)} ${nsName} = require(${mod});\n${indent}${cjsDecl(defaultName)} ${defaultName} = ${nsName}.default || ${nsName};`;
		}
	);

	// import { a, b as c } from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s*\{([^}]+)\}\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(match, indent, imports, mod) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (imports.includes('${')) return match;
			const modRef = '__imp_' + Math.random().toString(36).slice(2, 8);
			const mapped = imports.split(',').map((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const sourceProp = parts[0].trim();
				const localName = parts.length === 2 ? parts[1].trim() : sourceProp;
				if (localName) importSources.set(localName, { modRef, prop: sourceProp });
				if (parts.length === 2) return `${sourceProp}: ${localName}`;
				return sourceProp;
			}).filter((s: string) => s).join(', ');
			return `\n${indent}const ${modRef} = require(${mod});\n${indent}const { ${mapped} } = ${modRef};`;
		}
	);

	// import * as X from 'mod'
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s*\*\s*as\s+([\w$]+)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, name, mod) => `\n${indent}${cjsDecl(name)} ${name} = require(${mod});`
	);

	// import X from 'mod' (default import)
	// ESM-transformed modules put the default on exports.default; plain CJS
	// modules ARE the default. Prefer .default when present (matches the
	// interop of the combined import rules above).
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s+([\w$]+)\s+from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, name, mod) => {
			const tmp = '__mod_' + name;
			return `\n${indent}${cjsDecl(tmp)} ${tmp} = require(${mod});\n${indent}${cjsDecl(name)} ${name} = ${tmp} && ${tmp}.default !== undefined ? ${tmp}.default : ${tmp};`;
		}
	);

	// import 'mod' (side-effect)
	result = result.replace(
		/(?:^|\n)([ \t]*)import\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, mod) => `\n${indent}require(${mod});`
	);

	// --- Export transforms ---

	// Strip empty export{} (bundler ESM marker, no-op)
	result = result.replace(/(?:^|\n)[ \t]*export\s*\{\s*\}[ \t]*;?/g, '');

	// export * from 'mod' — use getter-based forwarding for live bindings
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\*\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, mod) => {
			const tmpVar = '__star_' + Math.random().toString(36).slice(2, 8);
			return `\n${indent}const ${tmpVar} = require(${mod});\n${indent}Object.keys(${tmpVar}).forEach(function(k) { if (k !== 'default' && !exports.hasOwnProperty(k)) Object.defineProperty(exports, k, { get: function() { return ${tmpVar}[k]; }, enumerable: true, configurable: true }); });`;
		}
	);

	// export { a, b } from 'mod' (re-export) — use getters for live bindings
	// (handles circular dependencies where source module isn't fully populated yet)
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\{([^}]+)\}\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(match, indent, names, mod) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (names.includes('${')) return match;
			const tmpVar = '__re_' + Math.random().toString(36).slice(2, 8);
			const assignments = names.split(',').map((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const local = parts[0].trim();
				const exported = parts.length === 2 ? parts[1].trim() : local;
				return `${indent}Object.defineProperty(exports, '${exported}', { get() { return ${tmpVar}.${local}; }, enumerable: true, configurable: true });`;
			}).join('\n');
			return `\n${indent}const ${tmpVar} = require(${mod});\n${assignments}`;
		}
	);

	// export default <expr> — must come before named export { }
	if (hasDefaultExport && hasNamedExport) {
		result = result.replace(
			/(?:^|\n)([ \t]*)export\s+default\s+/g,
			(_match, indent) => `\n${indent}exports.default = `
		);
	} else {
		result = result.replace(
			/(?:^|\n)([ \t]*)export\s+default\s+/g,
			(_match, indent) => `\n${indent}module.exports = `
		);
	}

	// export const/let/var x = ...
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s+(const|let|var)\s+([\w$]+)\s*=/g,
		(match, indent, keyword, name) => {
			// Guard: ${ means regex matched inside a template literal
			if (match.includes('${')) return match;
			return `\n${indent}${keyword} ${name} = exports.${name} =`;
		}
	);

	// export function f(...) / export async function f(...) / export class C
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s+(async\s+function\s+([\w$]+)|function\s+([\w$]+)|class\s+([\w$]+))/g,
		(match, indent, decl, asyncFnName, fnName, className, offset: number) => {
			// Guard: if char after match is '{', it's a template literal `export function ${fn}`
			// Real exports have '(' after function name or '{' after class + whitespace
			const nextChar = result.charAt(offset + match.length);
			if (nextChar === '{') return match;
			const name = asyncFnName || fnName || className;
			trailingExports.push(`exports.${name} = ${name};`);
			return `\n${indent}${decl}`;
		}
	);

	// export { a, b as c } (local exports, no from)
	// Use trailing exports to ensure declarations are fully initialized.
	// For names that were imported from another module, use getters pointing
	// back to the source module reference — this creates ESM-like live bindings
	// that survive circular dependencies.
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\{([^}]+)\}[ \t]*;?/g,
		(match, _indent, names) => {
			// Guard: ${ in captured names means regex matched inside a template literal
			if (names.includes('${')) return match;
			names.split(',').forEach((s: string) => {
				const parts = s.trim().split(/\s+as\s+/);
				const local = parts[0].trim();
				const exported = parts.length === 2 ? parts[1].trim() : local;
				if (!local) return;
				// ES2022 arbitrary string export names (export { x as "module.exports" })
				// arrive here quoted (masked); they need bracket/computed access.
				const isStringName = exported.startsWith('"') || exported.startsWith("'");
				const src = importSources.get(local);
				if (src) {
					// Imported name → lazy getter reading from source module reference
					const key = isStringName ? exported : `'${exported}'`;
					trailingExports.push(`Object.defineProperty(exports, ${key}, { get: function() { return ${src.modRef}.${src.prop}; }, enumerable: true, configurable: true });`);
				} else if (isStringName) {
					trailingExports.push(`exports[${exported}] = ${local};`);
				} else {
					// Locally defined → direct assignment at end of file
					trailingExports.push(`exports.${exported} = ${local};`);
				}
			});
			return '';
		}
	);

	// --- Other transforms ---

	// Rewrite dynamic import() → __lifoRequire (browser has no bare-specifier import).
	result = rewriteDynamicImportsMasked(result);

	// --- Final fixups ---

	// Replace const/let declarations of CJS wrapper param names with var.
	// esbuild bundles often emit `const __dirname = ...` which collides with
	// the new Function() wrapper parameters. `var` can shadow them safely.
	result = result.replace(
		/\b(const|let)\s+(__dirname|__filename|exports|require|module|console|process|Buffer|global)\b/g,
		(_match, _kw, name) => `var ${name}`
	);

	// Append trailing exports for exported functions/classes
	if (trailingExports.length > 0) {
		result += '\n' + trailingExports.join('\n');
	}

	// Restore original string/template literal contents
	result = unmaskStringLiterals(result, literals);

	// Stable require alias for the dynamic-import transforms above — captured
	// at wrapper scope before any module-level `var require` shadow can hoist.
	if (result.includes('__lifoRequire(')) {
		// Node's dynamic import() of a CJS module exposes module.exports as the
		// namespace `.default`. Our import() maps to require(), so add that interop
		// (e.g. @expo/metro-config does `(await import('browserslist')).default(...)`
		// — browserslist is `module.exports = fn`, so without a `.default` it throws
		// "browserslist.default is not a function"). Non-enumerable + only when
		// absent, so it's invisible to spreads and leaves ESM modules untouched.
		result = 'var __lifoRequire = function (id) { var m = require(id); if (m != null && !m.__esModule && (typeof m === "object" || typeof m === "function") && !("default" in m)) { try { Object.defineProperty(m, "default", { value: m, configurable: true }); } catch (e) {} } return m; };\n' + result;
	}

	return result;
}

function createNodeImpl(kernelOrPortRegistry?: Kernel | Map<number, VirtualRequestHandler>): Command {
	return async (ctx) => {
		// Handle -v/--version
		if (ctx.args.length > 0 && (ctx.args[0] === '-v' || ctx.args[0] === '--version')) {
			ctx.stdout.write(NODE_VERSION + '\n');
			return 0;
		}

		// Handle --help
		if (ctx.args.length > 0 && ctx.args[0] === '--help') {
			ctx.stdout.write('Usage: node [-e code] [script.js] [args...]\n');
			ctx.stdout.write('       node -v\n\n');
			ctx.stdout.write('Options:\n');
			ctx.stdout.write('  -e, --eval <code>   evaluate code\n');
			ctx.stdout.write('  -v, --version       print version\n\n');
			ctx.stdout.write('Limitations:\n');
			ctx.stdout.write('  - ESM support via auto-transform (import/export → require/exports)\n');
			ctx.stdout.write('  - No event loop (top-level async does not settle)\n');
			ctx.stdout.write('  - No native modules\n');
			ctx.stdout.write('  - require() resolves: built-in modules, relative VFS files, installed packages\n');
			return 0;
		}

		let source: string;
		let filename: string;
		let scriptArgs: string[];

		// Handle -e / --eval
		if (ctx.args.length > 0 && (ctx.args[0] === '-e' || ctx.args[0] === '--eval')) {
			if (ctx.args.length < 2) {
				ctx.stderr.write('node: -e requires an argument\n');
				return 1;
			}
			source = ctx.args[1];
			filename = '[eval]';
			scriptArgs = ctx.args.slice(2);
		} else if (ctx.args.length > 0) {
			// Run script file
			const scriptPath = resolve(ctx.cwd, ctx.args[0]);
			try {
				source = ctx.vfs.readFileString(scriptPath);
			} catch (e) {
				if (e instanceof VFSError) {
					ctx.stderr.write(`node: ${ctx.args[0]}: ${e.message}\n`);
					return 1;
				}
				throw e;
			}
			filename = scriptPath;
			scriptArgs = ctx.args.slice(1);
		} else {
			// No args -- print usage hint
			ctx.stderr.write('Usage: node [-e code] [script.js] [args...]\n');
			return 1;
		}

		const dir = filename === '[eval]' ? ctx.cwd : dirname(filename);

		// Extract portRegistry from either Kernel or direct Map
		const portRegistry = kernelOrPortRegistry instanceof Map
			? kernelOrPortRegistry
			: kernelOrPortRegistry?.portRegistry;

		// Count in-flight child processes. create-expo-app shells out to `npm
		// install` (and post-install steps like `git init`) via child_process; that
		// work registers no fetch and may go quiet for seconds (e.g. package
		// extraction/linking), so without tracking it the quiescence wait below
		// would mistake a busy install for an idle run and hand the prompt back
		// before the CLI finishes — its final "your project is ready" then prints
		// after the shell prompt (seen with Expo SDK 57).
		let pendingChild = 0;
		const trackChild = <F extends ((...a: never[]) => Promise<unknown>) | undefined>(run: F): F => {
			if (!run) return run;
			return ((...a: Parameters<NonNullable<F>>) => {
				pendingChild++;
				return Promise.resolve((run as NonNullable<F>)(...a)).finally(() => { pendingChild--; });
			}) as F;
		};

			// Real process.exit() kills the process — nothing prints afterward. In the
		// VM an event-driven exit() must RETURN rather than throw (so a caller like
		// Expo's Ctrl+C handler, which calls process.exit() at the end of a try
		// block, completes cleanly instead of hitting its catch — see requestExit).
		// That means code after process.exit() keeps running. Gate all program
		// output on this flag so anything written post-exit stays silent, matching
		// Node. Without it, Expo's logCmdError prints a CommandError's message and
		// then — in a fall-through path Node never reaches — re-prints it with the
		// full stack trace. Set by requestExit() when an exit is handled.
		let exited = false;
		const gateStream = <S extends { write: (chunk: string) => unknown }>(s: S): S =>
			new Proxy(s, {
				get(target, prop, recv) {
					if (prop === 'write') {
						return (chunk: string) => (exited ? true : (target.write as (c: string) => unknown).call(target, chunk));
					}
					return Reflect.get(target, prop, recv);
				},
			});
		const runStdout = gateStream(ctx.stdout);
		const runStderr = gateStream(ctx.stderr);
	const nodeCtx: NodeContext = {
			vfs: ctx.vfs,
			cwd: ctx.cwd,
			// Copy the shell env once so the node run has its own process.env
			// (isolated from the shell) that is then shared across all its modules.
			env: { ...ctx.env },
			stdout: runStdout,
			stderr: runStderr,
			argv: [filename, ...scriptArgs],
			filename,
			dirname: dir,
			signal: ctx.signal,
			portRegistry,
			// Lets child_process (exec/spawn) shell out to other VM commands —
			// e.g. create-expo-app running `npm pack` / `npm install`.
			executeCapture: trackChild(ctx.executeCapture),
			executeCaptureResult: trackChild(ctx.executeCaptureResult),
		};

		// Back require('module')'s Module#_compile with the real module executor
		// (require-from-string constructs a Module and compiles source directly —
		// e.g. @expo/config evaluating app.config.js). executeModule is declared
		// below in this scope; the arrow defers the reference until call time.
		nodeCtx.executeCjs = (code, fname) => executeModule(code, fname);

		// One interactive stdin for the whole run, backed by the shell's terminal
		// input. `ctx.setRawMode` is only provided on interactive terminal runs, so
		// its presence is our isTTY signal (enables Expo's keypress UI, etc.). The
		// SAME object is shared across main + all module processes so keypresses
		// aren't split between competing readers.
		const interactive = !!ctx.setRawMode;
		const nodeStdin = createInteractiveStdin(ctx.stdin, ctx.setRawMode, interactive);

		// Injected as the `fetch` wrapper param for every executed module, so calls
		// to known non-CORS hosts (api.expo.dev, which create-expo-app hits) are
		// routed through a browser-reachable CORS proxy. Injecting as a param
		// (rather than overriding globalThis.fetch) reliably shadows the bundle's
		// fetch reference. Undefined in real Node (test runner) — falls through to
		// the global fetch.
		const realFetch = (globalThis as { fetch?: typeof fetch }).fetch;
		// Count in-flight fetches so the completion wait below knows the run still
		// has pending async work (e.g. create-expo-app fetching SDK versions).
		let pendingAsync = 0;
		const proxying = typeof realFetch === 'function'
			? makeProxyingFetch(realFetch.bind(globalThis), nodeCtx.env)
			: realFetch;
		const nodeFetch = (typeof proxying === 'function'
			? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					pendingAsync++;
					let p: Promise<Response>;
					try { p = proxying(input, init); } catch (e) { pendingAsync--; throw e; }
					return Promise.resolve(p).finally(() => { pendingAsync--; });
				})
			: proxying) as typeof fetch;

		// Serve require('fetch-nodeshim') from the native fetch stack — see
		// makeFetchNodeshim. Built per-run so it uses this run's proxying fetch.
		const fetchNodeshim = typeof nodeFetch === 'function' ? makeFetchNodeshim(nodeFetch) : undefined;

		// process.exit() handling. While the main script is still executing
		// synchronously, exit() must throw (to abort it). Once we're purely
		// event-driven (a long-running server is up and we're just awaiting it),
		// an exit() from an event handler — e.g. Expo's Ctrl+C, which calls
		// process.exit() inside a try/catch right after stopping the server —
		// should end the run WITHOUT throwing, so that handler completes cleanly
		// instead of hitting its catch ("Failed to stop server") and cascading.
		let interceptExit = false;
		let asyncExitCode: number | null = null;
		const requestExit = (code: number): boolean => {
			if (!interceptExit) return false; // still in the sync script → throw as usual
			asyncExitCode = code;
			exited = true; // real process.exit() is now dead: silence any post-exit output
			signalExit();
			return true;
		};

		const moduleMap = createModuleMap(nodeCtx);
		const moduleCache = new Map<string, unknown>();

		// Stub for @rollup/rollup-* native binary packages (platform-specific NAPI addons).
		// These can't work in a browser environment. Provide shims for the exported functions.
		// Vite's dev server primarily uses es-module-lexer, not rollup's parser, so these
		// may never be called. If they are, hash stubs return safe defaults; parse stubs throw.
		const rollupParseShim = createRollupParseShim();
		let loadingBabelSync = false;
		const rollupNativeStub = {
			parse: () => { throw new Error('[lifo] rollup native parser is not available in browser'); },
			parseAsync: () => Promise.reject(new Error('[lifo] rollup native parser is not available in browser')),
			xxhashBase64Url: (data: unknown) => {
				// Simple fallback hash — not cryptographically equivalent but sufficient for cache keys
				const s = typeof data === 'string' ? data : String(data);
				let h = 0;
				for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
				return (h >>> 0).toString(36);
			},
			xxhashBase36: (data: unknown) => {
				const s = typeof data === 'string' ? data : String(data);
				let h = 0;
				for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
				return (h >>> 0).toString(36);
			},
			xxhashBase16: (data: unknown) => {
				const s = typeof data === 'string' ? data : String(data);
				let h = 0;
				for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
				return (h >>> 0).toString(16);
			},
		};

		// Stub for `lightningcss` — a native (Rust NAPI) CSS transformer that
		// can't load in the browser (`Cannot find module '../lightningcss.*.node'`).
		// SDK 57's @expo/metro-config uses it to transform/minify web CSS
		// (transformCssModuleWeb → require('lightningcss')), which otherwise
		// crashes `expo start --web` bundling. Pass CSS through unchanged — dev
		// bundles don't need minification, and react-native-web injects its own
		// styles at runtime rather than via these CSS files.
		const toBuf = (v: unknown) => (Buffer.isBuffer(v) ? v : Buffer.from((v as string | Uint8Array) ?? ''));
		const lightningcssStub = {
			transform: (opts: { code?: unknown; cssModules?: unknown }) => ({
				code: toBuf(opts?.code),
				map: undefined,
				exports: opts?.cssModules ? {} : undefined,
				references: {},
				dependencies: [],
				warnings: [],
			}),
			transformStyleAttribute: (opts: { code?: unknown }) => ({ code: toBuf(opts?.code), warnings: [] }),
			bundle: () => ({ code: Buffer.from(''), map: undefined, exports: undefined, warnings: [] }),
			bundleAsync: () => Promise.resolve({ code: Buffer.from(''), map: undefined, exports: undefined, warnings: [] }),
			browserslistToTargets: () => ({}),
			composeVisitors: () => ({}),
			Features: new Proxy({}, { get: () => 0 }),
		};

		// Build require function (declared first, module shim overrides below)
		function nodeRequire(name: string): unknown {
			// Strip node: prefix
			if (name.startsWith('node:')) name = name.slice(5);
			// file:// URLs (e.g. vite importing its bundled config) → plain paths
			if (name.startsWith('file://')) name = decodeURIComponent(name.slice('file://'.length));
			// Metro's `--for-<purpose>` distinct-instance marker (e.g.
			// `@babel/traverse--for-generate-function-map`) → real package.
			if (!name.startsWith('.') && !name.startsWith('/')) {
				const m = name.indexOf('--for-');
				if (m !== -1) name = name.slice(0, m);
			}

			// rollup/parseAst is a native NAPI binding — serve the acorn-backed shim
			if (name === 'rollup/parseAst' || name === 'rollup/parseAst.js') return rollupParseShim;

			// lightningcss (native CSS transformer) — intercept before node_modules
			// resolution, since it IS installed (its index.js would load a missing
			// .node binary). See lightningcssStub.
			if (name === 'lightningcss') return lightningcssStub;
			// fetch-nodeshim: serve the native fetch stack (see makeFetchNodeshim) —
			// intercept BEFORE node_modules resolution since the package IS installed.
			if (name === 'fetch-nodeshim' && fetchNodeshim) return fetchNodeshim;

			// @babel/core: answer the async API with sync execution (see babel-sync.ts)
			if (name === '@babel/core') {
				const key = '__lifo:babel-sync';
				const cached = moduleCache.get(key);
				if (cached) return cached;
				if (!loadingBabelSync) {
					loadingBabelSync = true;
					try {
						const wrapped = wrapBabelSync(nodeRequire('@babel/core') as Record<string, unknown>);
						moduleCache.set(key, wrapped);
						return wrapped;
					} finally {
						loadingBabelSync = false;
					}
				}
				// re-entrant (babel loading itself) — fall through to normal resolution
			}

			// Check cache
			if (moduleCache.has(name)) return moduleCache.get(name);

			// Built-in modules
			if (moduleMap[name]) {
				const mod = moduleMap[name]();
				moduleCache.set(name, mod);
				return mod;
			}

			// Subpath imports (#specifier)
			if (name.startsWith('#')) {
				const resolved = resolvePackageImport(name, dir);
				if (resolved) {
					const cached = moduleCache.get(resolved.path);
					if (cached) return cached;
					const modSource = ctx.vfs.readFileString(resolved.path);
					return executeModule(modSource, resolved.path, resolved.path);
				}
				throw new Error(`Cannot find module '${name}'`);
			}

			// Relative VFS files
			if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
				const resolved = resolveVfsModule(name, dir);
				if (resolved) {
					const cached = moduleCache.get(resolved.path);
					if (cached) return cached;

					if (resolved.path.endsWith('.json')) {
						const content = ctx.vfs.readFileString(resolved.path);
						const parsed = JSON.parse(content);
						moduleCache.set(resolved.path, parsed);
						return parsed;
					}

					const modSource = ctx.vfs.readFileString(resolved.path);
					return executeModule(modSource, resolved.path, resolved.path);
				}

				throw new Error(`Cannot find module '${name}'`);
			}

			// Node-modules resolution (walk up node_modules, global, legacy)
			const nmResolved = resolveNodeModule(name, dir);
			if (nmResolved) {
				const cached = moduleCache.get(nmResolved.path);
				if (cached) return cached;

				if (nmResolved.path.endsWith('.json')) {
					const content = ctx.vfs.readFileString(nmResolved.path);
					const parsed = JSON.parse(content);
					moduleCache.set(nmResolved.path, parsed);
					return parsed;
				}

				const modSource = ctx.vfs.readFileString(nmResolved.path);
				return executeModule(modSource, nmResolved.path, nmResolved.path);
			}

			// Stub for rollup native binary packages
			if (name.startsWith('@rollup/rollup-')) return rollupNativeStub;

			throw new Error(`Cannot find module '${name}'`);
		}

		// require.resolve(id) — return the resolved path without loading (used
		// by Metro/@expo/cli to locate transformers, polyfills, externals).
		function resolveRequirePath(name: string, fromDir: string): string {
			if (name.startsWith('node:')) name = name.slice(5);
			if (moduleMap[name]) return name; // builtin — return the id
			if (name.startsWith('#')) {
				const r = resolvePackageImport(name, fromDir);
				if (r) return r.path;
			} else if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
				const r = resolveVfsModule(name, fromDir);
				if (r) return r.path;
			} else {
				const r = resolveNodeModule(name, fromDir);
				if (r) return r.path;
			}
			const err = new Error(`Cannot find module '${name}'`) as Error & { code: string };
			err.code = 'MODULE_NOT_FOUND';
			throw err;
		}

		// Node-internal resolution APIs that resolve-from (and other resolvers,
		// e.g. @expo/config's SDK-version detection) call:
		//   Module._resolveFilename(request, { filename }) and
		//   Module._nodeModulePaths(dir).
		function moduleResolveExtras(fallbackDir: string) {
			return {
				_resolveFilename: (request: string, parent?: { filename?: string; id?: string }): string => {
					let fromDir = fallbackDir;
					if (parent && typeof parent.filename === 'string') fromDir = dirname(parent.filename);
					else if (parent && typeof parent.id === 'string' && parent.id.includes('/')) fromDir = dirname(parent.id);
					return resolveRequirePath(request, fromDir);
				},
				_nodeModulePaths: (from: string): string[] => {
					const paths: string[] = [];
					let cur = from;
					for (;;) {
						paths.push(join(cur, 'node_modules'));
						const p = dirname(cur);
						if (p === cur) break;
						cur = p;
					}
					return paths;
				},
			};
		}
		(nodeRequire as unknown as { resolve: unknown }).resolve = Object.assign(
			(id: string) => resolveRequirePath(id, dir),
			{ paths: () => null },
		);
		(nodeRequire as unknown as { cache: unknown }).cache = Object.create(null);

		// Override module shim so createRequire returns nodeRequire (resolves VFS +
		// node_modules). Must stay a constructable Module class with a working
		// _compile: require-from-string does `new (require('module'))(...)` +
		// `m._compile(code)` (e.g. @expo/config evaluating app.config.js).
		moduleMap.module = () => {
			const builtinNames = Object.keys(moduleMap);
			return createModuleClass(
				{ executeCjs: nodeCtx.executeCjs },
				{
					createRequire: (_filename: string | URL) => nodeRequire,
					builtinModules: builtinNames,
					isBuiltin: (s: string) => {
						const n = s.startsWith('node:') ? s.slice(5) : s;
						return builtinNames.includes(n);
					},
					...moduleResolveExtras(dir),
				},
			);
		};

		function resolveVfsModule(name: string, fromDir: string): { path: string } | null {
			const absPath = resolve(fromDir, name);

			// Try exact path
			if (ctx.vfs.exists(absPath)) {
				try {
					const stat = ctx.vfs.stat(absPath);
					if (stat.type === 'file') return { path: absPath };
					// Directory -- try package.json main, then index.*
					const pkgPath = join(absPath, 'package.json');
					if (ctx.vfs.exists(pkgPath)) {
						try {
							const pkg = JSON.parse(ctx.vfs.readFileString(pkgPath));
							const main = typeof pkg.module === 'string' ? pkg.module : (typeof pkg.main === 'string' ? pkg.main : null);
							if (main) {
								const mainResolved = resolveVfsModule('./' + main, absPath);
								if (mainResolved) return mainResolved;
							}
						} catch { /* fall through to index */ }
					}
					for (const ext of ['.js', '.mjs', '.cjs', '.json']) {
						const indexPath = join(absPath, 'index' + ext);
						if (ctx.vfs.exists(indexPath)) return { path: indexPath };
					}
				} catch { /* fall through */ }
			}

			// Append extensions when the exact path doesn't resolve. Node does
			// this regardless of dots in the specifier, so a require of
			// './webauthn.errors' must still find 'webauthn.errors.js'.
			for (const ext of ['.js', '.mjs', '.cjs', '.json']) {
				if (ctx.vfs.exists(absPath + ext)) return { path: absPath + ext };
			}

			return null;
		}

		// ── Subpath imports (#specifier) resolution ──
		// Node.js package.json "imports" field: #name → conditional file path

		function resolvePackageImport(name: string, fromDir: string): { path: string } | null {
			// Walk up to find the nearest package.json with an "imports" field
			let current = fromDir;
			for (; ;) {
				const pkgPath = join(current, 'package.json');
				if (ctx.vfs.exists(pkgPath)) {
					try {
						const pkg = JSON.parse(ctx.vfs.readFileString(pkgPath));
						if (pkg.imports && typeof pkg.imports === 'object') {
							const importsMap = pkg.imports as Record<string, unknown>;
							if (name in importsMap) {
								const target = resolveExportsCondition(importsMap[name]);
								if (target) {
									return resolveVfsModule(target, current);
								}
							}
						}
					} catch { /* ignore parse errors */ }
					break; // Stop at nearest package.json (Node.js semantics)
				}
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}
			return null;
		}

		// ── Node-modules resolution (walk up, global, legacy) ──

		function resolveNodeModule(name: string, fromDir: string): { path: string } | null {
			// Parse package name and optional subpath
			let packageName: string;
			let subpath: string | null = null;

			if (name.startsWith('@')) {
				const parts = name.split('/');
				if (parts.length < 2) return null;
				packageName = parts[0] + '/' + parts[1];
				if (parts.length > 2) subpath = parts.slice(2).join('/');
			} else {
				const slashIdx = name.indexOf('/');
				if (slashIdx !== -1) {
					packageName = name.slice(0, slashIdx);
					subpath = name.slice(slashIdx + 1);
				} else {
					packageName = name;
				}
			}

			// Walk up from fromDir
			let current = fromDir;
			for (; ;) {
				const candidate = join(current, 'node_modules', packageName);
				if (ctx.vfs.exists(candidate)) {
					const resolved = resolvePackageEntry(candidate, subpath);
					if (resolved) return resolved;
				}
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}

			// Global modules
			const globalCandidate = join('/usr/lib/node_modules', packageName);
			if (ctx.vfs.exists(globalCandidate)) {
				const resolved = resolvePackageEntry(globalCandidate, subpath);
				if (resolved) return resolved;
			}

			// Legacy location (pkg command)
			const legacyCandidate = join('/usr/share/pkg/node_modules', packageName);
			if (ctx.vfs.exists(legacyCandidate)) {
				const resolved = resolvePackageEntry(legacyCandidate, subpath);
				if (resolved) return resolved;
			}

			return null;
		}

		/** Resolve a conditional exports value (string | { require, import, default, ... }) */
		function resolveExportsCondition(value: unknown): string | null {
			if (typeof value === 'string') return value;
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				const cond = value as Record<string, unknown>;
				// This is a require() context, so honour Node's require conditions
				// in priority order and recurse into nested condition objects
				// (e.g. { require: { types, default } }). Crucially, 'import'
				// (the ESM build) must be tried LAST — a dual package like
				// signal-exit lists "import" first, and picking it would load an
				// ESM file in a CJS require.
				for (const key of ['require', 'node', 'default', 'browser']) {
					if (key in cond) {
						const r = resolveExportsCondition(cond[key]);
						if (r) return r;
					}
				}
				// Any remaining non-standard condition, then finally import.
				for (const key of Object.keys(cond)) {
					if (key === 'types' || key === 'import' || key === 'require' || key === 'node' || key === 'default' || key === 'browser') continue;
					const r = resolveExportsCondition(cond[key]);
					if (r) return r;
				}
				if ('import' in cond) {
					const r = resolveExportsCondition(cond.import);
					if (r) return r;
				}
			}
			return null;
		}

		function resolvePackageEntry(pkgDir: string, subpath: string | null): { path: string } | null {
			const pkgJsonPath = join(pkgDir, 'package.json');
			let pkgJson: Record<string, unknown> | null = null;
			if (ctx.vfs.exists(pkgJsonPath)) {
				try { pkgJson = JSON.parse(ctx.vfs.readFileString(pkgJsonPath)); } catch { /* ignore */ }
			}

			// --- Subpath resolution (e.g. require('rollup/parseAst')) ---
			if (subpath) {
				// 1. Check exports map first (Node.js subpath exports)
				if (pkgJson?.exports && typeof pkgJson.exports === 'object') {
					const exportsMap = pkgJson.exports as Record<string, unknown>;
					const key = './' + subpath;
					if (key in exportsMap) {
						const target = resolveExportsCondition(exportsMap[key]);
						if (target) {
							const resolved = resolveVfsModule(target, pkgDir);
							if (resolved) return resolved;
						}
					}
					// Wildcard subpath patterns (Node "exports" globs). The key has
					// exactly one '*' that matches any substring; the capture is
					// substituted into the target's '*', which may sit ANYWHERE in
					// the target — not just at the end. e.g. metro SDK 54+ maps
					// "./private/*": "./src/*.js", so metro/private/lib/Foo →
					// metro/src/lib/Foo.js. Most-specific (longest prefix) wins.
					const wildcardMatches: Array<{ prefixLen: number; target: string }> = [];
					for (const pattern of Object.keys(exportsMap)) {
						const star = pattern.indexOf('*');
						if (star === -1) continue;
						const pre = pattern.slice(0, star);
						const post = pattern.slice(star + 1);
						if (key.length < pre.length + post.length) continue;
						if (!key.startsWith(pre) || !key.endsWith(post)) continue;
						const captured = key.slice(pre.length, key.length - post.length);
						const targetPattern = resolveExportsCondition(exportsMap[pattern]);
						if (targetPattern && targetPattern.includes('*')) {
							wildcardMatches.push({ prefixLen: pre.length, target: targetPattern.replace('*', captured) });
						}
					}
					wildcardMatches.sort((a, b) => b.prefixLen - a.prefixLen);
					for (const m of wildcardMatches) {
						const resolved = resolveVfsModule(m.target, pkgDir);
						if (resolved) return resolved;
					}
				}
				// 2. Fall back to direct file resolution
				return resolveVfsModule('./' + subpath, pkgDir);
			}

			// --- Root resolution (e.g. require('rollup')) ---

			// 1. Check exports["."] first
			if (pkgJson?.exports) {
				const exportsVal = pkgJson.exports;
				let rootExport: unknown = null;
				if (typeof exportsVal === 'string') {
					rootExport = exportsVal;
				} else if (typeof exportsVal === 'object' && !Array.isArray(exportsVal)) {
					const exportsMap = exportsVal as Record<string, unknown>;
					rootExport = exportsMap['.'] ?? null;
					// Handle case where exports IS the condition map (no "." key)
					if (!rootExport && ('require' in exportsMap || 'import' in exportsMap || 'default' in exportsMap)) {
						rootExport = exportsMap;
					}
				}
				if (rootExport) {
					const target = resolveExportsCondition(rootExport);
					if (target) {
						const resolved = resolveVfsModule(target, pkgDir);
						if (resolved) return resolved;
					}
				}
			}

			// 2. Check main field
			if (pkgJson?.main && typeof pkgJson.main === 'string') {
				const resolved = resolveVfsModule('./' + pkgJson.main, pkgDir);
				if (resolved) return resolved;
			}

			// 3. Default to index.js
			const indexPath = join(pkgDir, 'index.js');
			if (ctx.vfs.exists(indexPath)) return { path: indexPath };

			return null;
		}

		function executeModule(modSource: string, modFilename: string, cacheAs?: string): unknown {
			const modDir = dirname(modFilename);
			// `exports` free variable / initial exports object. Node keeps this
			// stable even after `module.exports` is reassigned.
			const modExports = {} as Record<string, unknown>;
			let currentExports: unknown = modExports;
			// Live `module.exports`: reassigning it mid-execution must update the
			// module cache IMMEDIATELY, so a circular require sees the reassigned
			// value rather than the pre-cached initial {}. semver's Range and
			// Comparator are mutually recursive and each does `module.exports =
			// Class` *before* requiring the other; without this, the second module
			// captures an empty {} → `new Comparator()` throws → `validRange('^x')`
			// returns null → downstream tools (npm-package-arg, expo install) break.
			const modModule = {
				get exports() { return currentExports; },
				set exports(v: unknown) {
					currentExports = v;
					if (cacheAs) moduleCache.set(cacheAs, v);
				},
			};

			// Pre-cache to handle circular dependencies (Node.js behaviour)
			if (cacheAs) {
				moduleCache.set(cacheAs, modExports);
			}

			const modNodeCtx: NodeContext = { ...nodeCtx, filename: modFilename, dirname: modDir };
			const modModuleMap = createModuleMap(modNodeCtx);
			const modProcess = createProcess({
				argv: nodeCtx.argv,
				env: nodeCtx.env,
				cwd: nodeCtx.cwd,
				stdout: runStdout,
				stderr: runStderr,
				stdin: nodeStdin,
				interactive,
				onExit: requestExit,
			});
			const modConsole = createConsole(runStdout, runStderr);

			function modRequire(name: string): unknown {
				// Strip node: prefix
				if (name.startsWith('node:')) name = name.slice(5);
				// file:// URLs (e.g. vite importing its bundled config) → plain paths
				if (name.startsWith('file://')) name = decodeURIComponent(name.slice('file://'.length));
				// Metro appends `--for-<purpose>` to force a distinct module instance
				// (e.g. `@babel/traverse--for-generate-function-map`). The real target is
				// the package before the marker.
				if (!name.startsWith('.') && !name.startsWith('/')) {
					const m = name.indexOf('--for-');
					if (m !== -1) name = name.slice(0, m);
				}

				// rollup/parseAst is a native NAPI binding — serve the acorn-backed shim
				if (name === 'rollup/parseAst' || name === 'rollup/parseAst.js') return rollupParseShim;

			// lightningcss (native CSS transformer) — intercept before node_modules
			// resolution, since it IS installed (its index.js would load a missing
			// .node binary). See lightningcssStub.
			if (name === 'lightningcss') return lightningcssStub;
			// fetch-nodeshim: serve the native fetch stack (see makeFetchNodeshim) —
			// intercept BEFORE node_modules resolution since the package IS installed.
			if (name === 'fetch-nodeshim' && fetchNodeshim) return fetchNodeshim;

				// @babel/core: answer the async API with sync execution (see babel-sync.ts)
				if (name === '@babel/core') {
					const key = '__lifo:babel-sync';
					const cached = moduleCache.get(key);
					if (cached) return cached;
					if (!loadingBabelSync) {
						loadingBabelSync = true;
						try {
							const wrapped = wrapBabelSync(modRequire('@babel/core') as Record<string, unknown>);
							moduleCache.set(key, wrapped);
							return wrapped;
						} finally {
							loadingBabelSync = false;
						}
					}
					// re-entrant (babel loading itself) — fall through to normal resolution
				}

				// Built-in modules from child context
				if (modModuleMap[name]) {
					const cached = moduleCache.get(name);
					if (cached) return cached;
					const mod = modModuleMap[name]();
					moduleCache.set(name, mod);
					return mod;
				}

				// Subpath imports (#specifier)
				if (name.startsWith('#')) {
					const resolved = resolvePackageImport(name, modDir);
					if (resolved) {
						const cached = moduleCache.get(resolved.path);
						if (cached) return cached;
						const childSource = ctx.vfs.readFileString(resolved.path);
						return executeModule(childSource, resolved.path, resolved.path);
					}
					throw new Error(`Cannot find module '${name}'`);
				}

				if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
					const resolved = resolveVfsModule(name, modDir);
					if (resolved) {
						const cached = moduleCache.get(resolved.path);
						if (cached) return cached;

						if (resolved.path.endsWith('.json')) {
							const content = ctx.vfs.readFileString(resolved.path);
							const parsed = JSON.parse(content);
							moduleCache.set(resolved.path, parsed);
							return parsed;
						}

						const childSource = ctx.vfs.readFileString(resolved.path);
						return executeModule(childSource, resolved.path, resolved.path);
					}
					throw new Error(`Cannot find module '${name}'`);
				}

				// Node-modules resolution from this module's directory
				const nmResolved = resolveNodeModule(name, modDir);
				if (nmResolved) {
					const cached = moduleCache.get(nmResolved.path);
					if (cached) return cached;

					if (nmResolved.path.endsWith('.json')) {
						const content = ctx.vfs.readFileString(nmResolved.path);
						const parsed = JSON.parse(content);
						moduleCache.set(nmResolved.path, parsed);
						return parsed;
					}

					const childSource = ctx.vfs.readFileString(nmResolved.path);
					return executeModule(childSource, nmResolved.path, nmResolved.path);
				}

				// Stub for rollup native binary packages
				if (name.startsWith('@rollup/rollup-')) return rollupNativeStub;

				throw new Error(`Cannot find module '${name}'`);
			}

			// require.resolve for child modules (resolves relative to this module).
			(modRequire as unknown as { resolve: unknown }).resolve = Object.assign(
				(id: string) => resolveRequirePath(id, modDir),
				{ paths: () => null },
			);
			(modRequire as unknown as { cache: unknown }).cache = Object.create(null);

			// Override module shim so createRequire returns modRequire (resolves VFS + node_modules too)
			// Same as the main map's override: a constructable Module class whose
			// createRequire is this module's scoped require.
			modModuleMap.module = () => {
				const builtinNames = Object.keys(modModuleMap);
				return createModuleClass(
					{ executeCjs: nodeCtx.executeCjs },
					{
						createRequire: (_filename: string | URL) => modRequire,
						builtinModules: builtinNames,
						isBuiltin: (s: string) => {
							const n = s.startsWith('node:') ? s.slice(5) : s;
							return builtinNames.includes(n);
						},
						...moduleResolveExtras(modDir),
					},
				);
			};

			let cleanSource = stripShebang(modSource);
			if (shouldTreatAsEsm(cleanSource, modFilename, ctx.vfs)) {
				cleanSource = transformEsmToCjs(cleanSource);
			} else {
				// CJS modules skip transformEsmToCjs, but still may use dynamic import()
				// (e.g. pglite's index.cjs → import('fs/promises')). Rewrite those too.
				cleanSource = rewriteDynamicImports(cleanSource);
			}
			const wrapped = `(function(${buildWrapperParams(cleanSource)}) {\n${cleanSource}\n})`;
			// Give the eval'd module a real filename in stack traces (CallSite.getFileName).
			// Tools like caller-path/importFresh (used by cosmiconfig) derive paths from the
			// call stack and break with anonymous eval frames.
			const sourceUrl = `\n//# sourceURL=${modFilename}`;

			let fn: (...args: unknown[]) => void;
			try {
				fn = new Function('return ' + wrapped + sourceUrl)();
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				ctx.stderr.write(`[ESM-FAIL] file=${modFilename} srcLen=${modSource.length} err=${err.message}\n`);
				// Binary search for exact error location, matching specific error
				const lines = cleanSource.split('\n');
				const targetErr = err.message;
				let lo = 0, hi = lines.length;
				while (hi - lo > 3) {
					const mid = (lo + hi) >>> 1;
					const partial = lines.slice(0, mid).join('\n');
					try { new Function(partial); lo = mid; } catch (e2) {
						if (e2 instanceof Error && e2.message === targetErr) hi = mid;
						else lo = mid; // Different error (e.g. unclosed), keep going
					}
				}
				ctx.stderr.write(`[ESM-FAIL] error at L${lo}-${hi}, showing L${Math.max(1, lo - 25)} to L${hi + 3}:\n`);
				for (let li = Math.max(0, lo - 25); li < Math.min(lines.length, hi + 3); li++) {
					ctx.stderr.write(`[ESM-FAIL] ${li + 1 === lo || li + 1 === hi ? '>>>' : '   '} L${li + 1}: ${lines[li]?.slice(0, 200)}\n`);
				}
				err.message = `[${modFilename}] ${err.message}`;
				throw err;
			}
			const global = makeNodeGlobal({ process: modProcess, Buffer, console: modConsole });
			// Many npm bundles access globalThis.process directly (not the wrapper param).
			// Only override in browser-like envs; skip in real Node.js (test runner).
			const ga = globalThis as Record<string, unknown>;
			const isRealNode = typeof (ga.process as Record<string, unknown>)?.pid === 'number';
			const savedProcess = ga.process;
			const savedBuffer = ga.Buffer;
			const savedConsole = ga.console;
			if (!isRealNode) {
				ga.process = modProcess;
				ga.Buffer = Buffer;
				ga.console = modConsole;
			}
			// Inject Rollup/esbuild interop helpers so bundled npm packages can find them
			const savedHelpers: Record<string, unknown> = {};
			for (const k of Object.keys(_rollupHelpers)) { savedHelpers[k] = ga[k]; ga[k] = _rollupHelpers[k]; }
			const importMetaUrl = 'file://' + modFilename;
			const importMeta = { url: importMetaUrl, dirname: modDir, filename: modFilename };
			const importMetaResolve = (specifier: string) => { throw new Error(`import.meta.resolve('${specifier}') is not supported`); };
			try {
				fn(
					modExports, modRequire, modModule, modFilename, modDir,
					modConsole, modProcess, Buffer,
					// Node-like timers: browser setTimeout returns a NUMBER, but Node
					// returns a Timeout object with unref/ref — packages test
					// `'unref' in timer` (dnssd-advertise) or call `.unref()` directly,
					// which throws on a number. The shim's Timer coerces back to the id.
					nodeTimers.setTimeout as unknown as typeof setTimeout, nodeTimers.setInterval as unknown as typeof setInterval,
					nodeTimers.clearTimeout as unknown as typeof clearTimeout, nodeTimers.clearInterval as unknown as typeof clearInterval,
					global,
					importMetaUrl, importMeta, importMetaResolve,
					// window/document/self undefined: node-executed code must see a Node
					// environment (no DOM), matching real Node — e.g. so Emscripten
					// (pglite) doesn't mis-detect the browser and mis-resolve data files.
					undefined, undefined, undefined, NODE_NAVIGATOR,
					nodeFetch, // fetch (CORS-proxied for known hosts)
				);
			} catch (e) {
				if (e instanceof ProcessExitError) throw e;
				const err = e instanceof Error ? e : new Error(String(e));
				if (!err.message.includes('[/')) {
					err.message = `[${modFilename}] ${err.message}`;
				}
				throw err;
			} finally {
				for (const k of Object.keys(savedHelpers)) ga[k] = savedHelpers[k];
				if (!isRealNode) {
					ga.process = savedProcess;
					ga.Buffer = savedBuffer;
					ga.console = savedConsole;
				}
			}

			// Update cache if module.exports was reassigned (not just mutated)
			if (cacheAs && modModule.exports !== modExports) {
				moduleCache.set(cacheAs, modModule.exports);
			}

			return modModule.exports;
		}

		// Execute main script
		const process = createProcess({
			argv: nodeCtx.argv,
			env: nodeCtx.env,
			cwd: nodeCtx.cwd,
			stdout: runStdout,
			stderr: runStderr,
			stdin: nodeStdin,
			interactive,
			onExit: requestExit,
		});
		const nodeConsole = createConsole(runStdout, runStderr);

		const module = { exports: {} as Record<string, unknown> };
		const exports = module.exports;
		const global = makeNodeGlobal({ process, Buffer, console: nodeConsole });

		let cleanMainSource = stripShebang(source);
		const isEsm = shouldTreatAsEsm(cleanMainSource, filename, ctx.vfs);
		if (isEsm) {
			cleanMainSource = transformEsmToCjs(cleanMainSource);
		}

		// Use async IIFE for ESM (supports top-level await)
		const wrapped = isEsm
			? `(async function(exports, require, module, __filename, __dirname, console, process, Buffer, setTimeout, setInterval, clearTimeout, clearInterval, global, __importMetaUrl, __importMeta, __importMetaResolve, window, document, self) {\n${cleanMainSource}\n})`
			: `(function(${buildWrapperParams(cleanMainSource)}) {\n${cleanMainSource}\n})`;

		// Many npm bundles access globalThis.process directly (not the wrapper param).
		// Only override in browser-like envs; skip in real Node.js (test runner).
		const ga = globalThis as Record<string, unknown>;
		const isRealNode = typeof (ga.process as Record<string, unknown>)?.pid === 'number';
		const savedProcess = ga.process;
		const savedBuffer = ga.Buffer;
		const savedConsole = ga.console;
		if (!isRealNode) {
			ga.process = process;
			ga.Buffer = Buffer;
			ga.console = nodeConsole;
		}
		// Inject Rollup/esbuild interop helpers so bundled npm packages can find them
		const savedHelpers: Record<string, unknown> = {};
		for (const k of Object.keys(_rollupHelpers)) { savedHelpers[k] = ga[k]; ga[k] = _rollupHelpers[k]; }
		// Capture unhandled promise rejections from fire-and-forget async actions
		let pendingRejection: unknown = null;
		// Resolves when the run should end because of an async exit — e.g. an
		// interactive keypress handler (Expo's Ctrl+C) calls process.exit(), which
		// throws ProcessExitError from the detached stdin pump. Without this the
		// long-lived server race below would never notice and the run would hang.
		let signalExit: () => void = () => {};
		const exitPromise = new Promise<void>((r) => { signalExit = r; });
		const rejectionHandler = (event: PromiseRejectionEvent) => {
			pendingRejection = event.reason;
			event.preventDefault(); // prevent browser default logging
			if (event.reason instanceof ProcessExitError) {
				signalExit();
			} else {
				ctx.stderr.write(`[unhandledRejection] ${event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason)}\n`);
			}
		};
		if (typeof globalThis.addEventListener === 'function') {
			globalThis.addEventListener('unhandledrejection', rejectionHandler as EventListener);
		}

		const mainImportMetaUrl = 'file://' + filename;
		const mainImportMeta = { url: mainImportMetaUrl, dirname: dir, filename };
		const mainImportMetaResolve = (specifier: string) => { throw new Error(`import.meta.resolve('${specifier}') is not supported`); };
		try {
			const fn = new Function('return ' + wrapped + `\n//# sourceURL=${filename}`)();
			const result = fn(
				exports, nodeRequire, module, filename, dir,
				nodeConsole, process, Buffer,
				// Node-like timers (Timeout objects with unref/ref) — see executeModule.
				nodeTimers.setTimeout as unknown as typeof setTimeout, nodeTimers.setInterval as unknown as typeof setInterval,
				nodeTimers.clearTimeout as unknown as typeof clearTimeout, nodeTimers.clearInterval as unknown as typeof clearInterval,
				global,
				mainImportMetaUrl, mainImportMeta, mainImportMetaResolve,
				undefined, undefined, undefined, NODE_NAVIGATOR,
				nodeFetch, // fetch (CORS-proxied for known hosts)
			);

			// Await if ESM (async IIFE returns a promise). The synchronous body of
			// the script has now run, so we're event-driven from here — a
			// process.exit() (e.g. Expo's Ctrl+C handler) should end the run
			// gracefully rather than throw. Race the main promise against
			// exitPromise: long-running servers await forever (`new Promise(()=>{})`),
			// so without this a graceful exit would hang on the never-resolving main.
			let mainResolved = false;
			if (isEsm && result && typeof result.then === 'function') {
				interceptExit = true;
				await Promise.race([result.then(() => { mainResolved = true; }), exitPromise]);
			}

			// Graceful async process.exit() (interactive keypress, etc.) — the
			// server was already torn down by whoever called exit(); just end.
			if (asyncExitCode !== null) {
				return asyncExitCode;
			}

			// We're event-driven now — a process.exit() should end the run
			// gracefully rather than throw.
			interceptExit = true;

			const getActiveServers = () => {
				const httpMod = moduleCache.get('http') as { [key: symbol]: unknown[] } | undefined;
				return httpMod?.[ACTIVE_SERVERS] as Array<{ getPromise(): Promise<void> | null; close(): void }> | undefined;
			};
			let activeServers = getActiveServers();

			// Keep the run alive while there's pending async work. Both CJS and ESM
			// CLIs run mostly async AFTER their synchronous entry — e.g.
			// create-expo-app: fetch SDK versions → interactive prompts → scaffold →
			// install. Returning right after the sync body would hand stdin back to
			// the shell mid-prompt. "Working" = an in-flight fetch, an active
			// interactive prompt reading stdin, or modules still loading. Ends when a
			// server starts (→ server race below), process.exit() fires, the run
			// aborts, or things stay quiescent for ~300ms (the script finished).
			if (!activeServers || activeServers.length === 0) {
				let prevCacheSize = moduleCache.size;
				let prevPending = pendingAsync;
				let lastInputSeq = (nodeStdin as unknown as { inputSeq?: number }).inputSeq ?? 0;
				// Track the last moment real work happened. We stop hanging once nothing
				// meaningful has moved for a grace window. This is deliberately wall-clock
				// based (not tick counters): a finished CLI that leaves stdin in raw mode
				// with a stray keypress listener (e.g. create-expo-app) makes isActive()
				// and rawMode *flicker*, which would defeat any consecutive-tick counter.
				let lastWorkMs = 0; // ms elapsed since loop start when work last happened
				let elapsed = 0;
				const hardDeadline = Date.now() + 600000; // 10 min cap (long installs)
				while (Date.now() < hardDeadline) {
					const tick = await Promise.race([
						new Promise<'tick'>((r) => setTimeout(() => r('tick'), 50)),
						exitPromise.then(() => 'exit' as const),
					]);
					if (tick === 'exit' || ctx.signal.aborted || pendingRejection || asyncExitCode !== null) break;
					elapsed += 50;
					activeServers = getActiveServers();
					if (activeServers && activeServers.length > 0) break;
					const seq = (nodeStdin as unknown as { inputSeq?: number }).inputSeq ?? 0;
					// "Meaningful work": an async op in flight, a child process running, a
					// new module loading, a new async op started, or fresh stdin input (the
					// user answering a prompt). A merely *attached* stdin consumer sitting
					// idle is NOT work — that's the leftover-listener case we time out.
					if (
						pendingAsync > 0 ||
						pendingChild > 0 ||
						moduleCache.size > prevCacheSize ||
						pendingAsync > prevPending ||
						seq !== lastInputSeq
					) {
						lastWorkMs = elapsed;
						prevCacheSize = moduleCache.size;
						prevPending = pendingAsync;
						lastInputSeq = seq;
					}
					// Grace after the last meaningful work: short once the ESM main has
					// resolved, longer otherwise (CJS has no such signal, so lean toward not
					// cutting a slow-to-answer interactive prompt short).
					const idleMs = elapsed - lastWorkMs;
					if (idleMs >= (mainResolved ? 500 : 2500)) break;
				}
			}

			if (asyncExitCode !== null) return asyncExitCode;

			if (activeServers && activeServers.length > 0) {
				// Collect all server promises
				const serverPromises = activeServers
					.map((s) => s.getPromise())
					.filter((p): p is Promise<void> => p !== null);

				if (serverPromises.length > 0) {
					// Wait for all servers to close OR for abort signal
					const abortPromise = new Promise<void>((resolve) => {
						if (ctx.signal.aborted) {
							resolve();
							return;
						}
						ctx.signal.addEventListener('abort', () => resolve(), { once: true });
					});

					// We're now purely event-driven — a process.exit() from here on
					// (e.g. an interactive keypress handler) should end the run
					// gracefully rather than throw.
					interceptExit = true;

					await Promise.race([
						Promise.all(serverPromises),
						abortPromise,
						exitPromise,
					]);

					// On abort or an async process.exit(), close all active servers.
					if (ctx.signal.aborted || pendingRejection || asyncExitCode !== null) {
						for (const server of [...activeServers]) {
							server.close();
						}
					}
				}
			}

			// A graceful async process.exit(code) (e.g. Expo's Ctrl+C) ended the run.
			if (asyncExitCode !== null) return asyncExitCode;

			// If an async action failed (e.g. unhandled rejection from ProcessExitError)
			if (pendingRejection) {
				if (pendingRejection instanceof ProcessExitError) return pendingRejection.exitCode;
				return 1;
			}
			return 0;
		} catch (e) {
			if (e instanceof ProcessExitError) {
				return e.exitCode;
			}
			if (e instanceof Error) {
				ctx.stderr.write(`${e.stack || e.message}\n`);
			} else {
				ctx.stderr.write(`${String(e)}\n`);
			}
			return 1;
		} finally {
			for (const k of Object.keys(savedHelpers)) ga[k] = savedHelpers[k];
			if (!isRealNode) {
				ga.process = savedProcess;
				ga.Buffer = savedBuffer;
				ga.console = savedConsole;
			}
			// Remove unhandled rejection listener
			if (typeof globalThis.removeEventListener === 'function') {
				globalThis.removeEventListener('unhandledrejection', rejectionHandler as EventListener);
			}
		}
	};
}

export function createNodeCommand(kernel: Kernel): Command {
	return createNodeImpl(kernel);
}

// Default command with a shared portRegistry so http.createServer works
const defaultPortRegistry = new Map<number, VirtualRequestHandler>();
const command: Command = createNodeImpl(defaultPortRegistry);

export default command;
