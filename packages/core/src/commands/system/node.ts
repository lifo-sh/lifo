import type { Command, CommandContext } from '../types.js';
import { resolve, dirname, join, extname } from '../../utils/path.js';
import { createModuleMap, ProcessExitError } from '../../node-compat/index.js';
import type { NodeContext } from '../../node-compat/index.js';
import type { ForkOptions } from '../../node-compat/child_process.js';
import { EventEmitter } from '../../node-compat/events.js';
import { instrumentAwaits } from '../../node-compat/await-context.js';
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
import { makeLoopbackFetch } from '../../kernel/network/loopback-fetch.js';
import { createOxideScanner } from '../../node-compat/tailwind-oxide.js';
import { adaptPackageSource } from './package-adapters.js';
import { needsTypeScript, loadTypeScript, stripTypes, jsxOptionsFromTsconfig, type JsxOptions } from '../../node-compat/typescript.js';
import { createSwcCore } from '../../node-compat/swc.js';
import { createEsbuild } from '../../node-compat/esbuild.js';
import * as nodeTimers from '../../node-compat/timers.js';
import { createActivityTracker, pendingWasm, trackWebAssembly } from '../../node-compat/activity.js';
import { createNapiWasiRuntime, isNapiWasiLoader, isWasmThreadsUnavailable } from '../../node-compat/napi-wasi/index.js';

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
// Extensions a relative import tries in a TypeScript run, in Bun's order.
const TS_RUN_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.mjs', '.js', '.mts', '.cjs', '.cts', '.json'];

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
	if (ext === '.mjs' || ext === '.mts') return true;
	if (ext === '.cjs' || ext === '.cts') return false;
	// Check nearest package.json "type" field (Node.js semantics; .ts follows it like .js)
	if (vfs && (ext === '.js' || ext === '.ts' || ext === '.tsx' || ext === '.jsx')) {
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
// `prevChar` is the previous SIGNIFICANT char (see maskStringLiterals' tracking):
// comments are transparent, and a string/regex value is reported as 'x'. This
// avoids scanning backward across comments — a regex on its own line after a
// `// comment` used to see the comment's last char and get misread as division,
// desyncing the whole masker (prettier's `.replace(\n // …\n /re/)`).
function isRegexStart(prevChar: string, prevIdx: number, src: string): 'strong' | 'weak' | false {
	if ('\0=([{,;!&|^~?:+-*%<>/'.includes(prevChar) ||
		(prevIdx >= 0 && /[A-Za-z_$]/.test(prevChar) &&
			/\b(?:return|typeof|void|delete|throw|new|case|of|in|yield|await)$/.test(src.slice(Math.max(0, prevIdx - 11), prevIdx + 1)))) {
		return 'strong';
	}
	if (')]}'.includes(prevChar)) return 'weak';
	return false;
}

/** Sanity check for a scanned regex candidate (leading slash..trailing slash+flags). */
function isPlausibleRegex(candidate: string): boolean {
	const lastSlash = candidate.lastIndexOf('/');
	if (lastSlash <= 0) return false;
	const body = candidate.slice(1, lastSlash);
	// Validate WITH the actual flags — a regex like /[\p{L}]/u is only valid with
	// `u`, so validating the body flagless wrongly rejected it, left it unmasked,
	// and its inner quotes desynced the whole masker (prettier is full of these).
	const flags = candidate.slice(lastSlash + 1);
	if (body.length === 0 || body.length > 2000 || body.includes('\n')) return false;
	try {
		new RegExp(body, /^[gimsuyvd]*$/.test(flags) ? flags : '');
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
	// Previous significant char, tracked exactly as maskStringLiterals does: the
	// '${' that opened this expression is an operator-ish context, comments are
	// transparent, and a string/regex literal is a value → 'x'.
	let prevChar = '{';
	let prevIdx = i - 1;
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
			const kind = isRegexStart(prevChar, prevIdx, src);
			if (kind) {
				const end = scanRegexLiteral(src, i);
				if (kind === 'strong' || isPlausibleRegex(src.slice(i, end))) {
					prevChar = 'x'; prevIdx = -1;
					i = end;
					continue;
				}
			}
		}
		if (c === "'" || c === '"') {
			i = scanQuoteLiteral(src, i);
			prevChar = 'x'; prevIdx = -1;
			continue;
		}
		if (c === '`') {
			i = scanTemplateLiteral(src, i);
			prevChar = 'x'; prevIdx = -1;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}') depth--;
		if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') { prevChar = c; prevIdx = i; }
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
	// Previous significant char for regex/division disambiguation. Comments are
	// transparent (don't update it); a string/regex literal is a value → 'x'.
	let prevChar = '\0';
	let prevIdx = -1;

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
			const kind = isRegexStart(prevChar, prevIdx, src);
			if (kind) {
				const end = scanRegexLiteral(src, i);
				if (kind === 'strong' || isPlausibleRegex(src.slice(i, end))) {
					masked += src.slice(i, end);
					prevChar = 'x'; prevIdx = -1; // a regex literal is a value
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
			prevChar = 'x'; prevIdx = -1; // a string/template literal is a value
			continue;
		}

		masked += ch;
		if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') { prevChar = ch; prevIdx = i; }
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
// The realm's setImmediate and clearImmediate before any program runs (node-compat set them up
// on import): a run follows the global only once a program replaces it.
const REALM_SET_IMMEDIATE = (globalThis as Record<string, unknown>).setImmediate;
const REALM_CLEAR_IMMEDIATE = (globalThis as Record<string, unknown>).clearImmediate;

const SHADOWABLE_WRAPPER_PARAMS = ['console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'global', 'window', 'document', 'self', 'navigator', 'fetch', 'setImmediate', 'clearImmediate'];

function buildWrapperParams(source: string): string {
	// setImmediate/clearImmediate come last (added after the rest): browsers have none, so a
	// bare `setImmediate(...)` (napi-rs loaders, emnapi) threw outside a Node host.
	const params = ['exports', 'require', 'module', '__filename', '__dirname', 'console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'global', '__importMetaUrl', '__importMeta', '__importMetaResolve', 'window', 'document', 'self', 'navigator', 'fetch', 'setImmediate', 'clearImmediate'];
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
		// (Identifier ends count `$` as part of the name: `const setTimeout$1` is another binding.)
		const direct = new RegExp(`(?:^|\\n)(?:class|let|const)\\s+${p}(?![\\w$])`);
		// Destructuring declaration, e.g. `const { Buffer } = require('node:buffer')` (undici).
		// A const/let re-binding a wrapper param name is a SyntaxError, so rename the param.
		// A renamed key isn't a binding: `const { setTimeout: setTimeout$1 } = ...` (Vite 8's
		// `import { setTimeout as setTimeout$1 } from 'node:timers/promises'`) binds only
		// setTimeout$1, and renaming the param there left the module's bare setTimeout() on the
		// browser's, whose number result has no .unref().
		const destructured = new RegExp(`(?:^|\\n)(?:let|const)\\s*\\{[^{}]*(?<![\\w$])${p}(?![\\w$]|\\s*:)[^{}]*\\}`);
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

	// export * as X from 'mod' — the module's namespace under one name (yoctocolors:
	// `export * as default from './base.js'`). X may also be a string name.
	result = result.replace(
		/(?:^|\n)([ \t]*)export\s*\*\s*as\s+([\w$]+|'[^'\n]*'|"[^"\n]*")\s*from\s*(['"][^'"]+['"])[ \t]*;?/g,
		(_match, indent, name, mod) => {
			const key = /^['"]/.test(name) ? name.slice(1, -1) : name;
			const tmpVar = '__ns_' + Math.random().toString(36).slice(2, 8);
			return `\n${indent}const ${tmpVar} = require(${mod});\n${indent}Object.defineProperty(exports, ${JSON.stringify(key)}, { get: function() { return ${tmpVar}; }, enumerable: true, configurable: true });`;
		}
	);

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
			// filter: a trailing comma (`export {\n  a,\n  b,\n} from …`, oxc-parser) leaves an empty name.
			const assignments = names.split(',').filter((s: string) => s.trim() !== '').map((s: string) => {
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
	// Only module-level ones collide: an indented declaration sits in a nested block or
	// function, where `let`/`const` legally shadows the parameter, while `var` would hoist to
	// that function and clash with a like-named `let` there (Vite 8's module-runner has
	// `let exports` in an `if` inside a method that also declares `exports`).
	result = result.replace(
		/\b(const|let)\s+(__dirname|__filename|exports|require|module|console|process|Buffer|global)\b/g,
		(match, _kw, name, offset: number, str: string) => {
			const lineStart = str.lastIndexOf('\n', offset - 1) + 1;
			const before = str.slice(lineStart, offset);
			if (before.length > 0 && /^[ \t]+$/.test(before)) return match;
			return `var ${name}`;
		}
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

/** Node's error for a require() that resolves to nothing: callers that treat a module as
 * optional check its code (Next.js loads instrumentation.js this way). */
function moduleNotFound(name: string): Error {
	return Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND', requireStack: [] as string[] });
}

/**
 * Environment defaults for tools whose default path needs native code a box can't run. Next.js
 * 16 bundles with Turbopack unless told otherwise, and Turbopack has no WebAssembly build; its
 * CLI picks webpack when IS_WEBPACK_TEST is set, so a plain `next dev` (as create-next-app
 * scaffolds it) works. Asking for Turbopack (a flag or TURBOPACK) still gets Turbopack.
 */
function nativeFreeDefaults(filename: string, args: string[], env: Record<string, string>): Record<string, string> {
	const isNextCli = /\/next\/dist\/bin\/next$/.test(filename);
	const wantsTurbopack = !!env.TURBOPACK || !!env.NEXT_RSPACK || args.some((a) => a === '--turbopack' || a === '--turbo');
	return isNextCli && !wantsTurbopack ? { IS_WEBPACK_TEST: '1' } : {};
}

/** A command a program ran with spawnSync and inherited output, to run once it ends. */
type AfterExitChild = { line: string; cwd: string };

/**
 * The IPC channel between a run and the run it started with child_process.fork(): the
 * parent's ChildProcess `send()` reaches the child's `process.on('message')` and the
 * child's `process.send()` reaches the parent's `child.on('message')`. Messages are
 * copied through JSON, Node's default serialization.
 */
interface NodeIpc {
	readonly connected: boolean;
	/** Child to parent. */
	toParent(msg: unknown): void;
	/** The child's run takes the parent's messages (queued until it does). */
	attach(deliver: (msg: unknown) => void): void;
	onDisconnect(fn: () => void): void;
	disconnect(): void;
}
const NODE_IPC = Symbol('lifo.node.ipc');
type ForkedContext = CommandContext & { [NODE_IPC]?: NodeIpc };
const ipcCopy = (msg: unknown): unknown => (msg === undefined ? undefined : JSON.parse(JSON.stringify(msg)));

function createNodeImpl(kernelOrPortRegistry?: Kernel | Map<number, VirtualRequestHandler>): Command {
	const command: Command = async (ctx) => {
		const afterExit: AfterExitChild[] = [];
		const code = await runProgram(ctx, afterExit);
		return runAfterExit(ctx, afterExit, code);
	};
	const runProgram = createNodeRun(kernelOrPortRegistry, command);
	return command;
}

/**
 * Run what the program asked for with spawnSync / execSync and inherited output (see
 * node-compat/child_process), in order, on this command's terminal, now that the program has
 * ended. The first failure stops the rest, and its code is the run's, as when the program
 * would have exited with a failed child's status. A program that failed or was stopped skips
 * them.
 */
async function runAfterExit(ctx: CommandContext, children: AfterExitChild[], code: number): Promise<number> {
	if (children.length === 0 || !ctx.runInherited || ctx.signal.aborted) return code;
	if (code !== 0) {
		const lines = children.map((c) => `"${c.line}"`).join(', ');
		ctx.stderr.write(`[lifo] skipped ${lines}: a box runs a program's synchronous commands after it ends, and it ended with code ${code}.\n`);
		return code;
	}
	for (const child of children) {
		const childCode = await ctx.runInherited(child.line, { cwd: child.cwd });
		if (childCode !== 0 || ctx.signal.aborted) return childCode;
	}
	return 0;
}

function createNodeRun(
	kernelOrPortRegistry: Kernel | Map<number, VirtualRequestHandler> | undefined,
	runNode: Command,
): (ctx: CommandContext, afterExit: AfterExitChild[]) => Promise<number> {
	return async (ctx, afterExit) => {
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
			// TypeScript and JSX entries (node 22.18+ strips types; bun runs .tsx/.jsx too).
			if (needsTypeScript(filename) && !(await loadTypeScript())) {
				ctx.stderr.write(`node: ${ctx.args[0]}: couldn't load the TypeScript transform (Sucrase)\n`);
				return 1;
			}
		} else {
			// No args -- print usage hint
			ctx.stderr.write('Usage: node [-e code] [script.js] [args...]\n');
			return 1;
		}

		const dir = filename === '[eval]' ? ctx.cwd : dirname(filename);

		// The run's working directory. process.chdir() moves it for this run only (the shell that
		// started it stays where it was, as with a real process); fs, path, process.cwd() and
		// child processes read it at call time.
		const runCwd = { value: ctx.cwd };
		const chdirRun = (to: string): void => {
			const target = String(to);
			const abs = resolve(runCwd.value, target);
			const fail = (code: string, errno: number, what: string): never => {
				throw Object.assign(new Error(`${code}: ${what}, chdir ${runCwd.value} -> '${target}'`), {
					errno, code, syscall: 'chdir', path: runCwd.value, dest: target,
				});
			};
			let type: string;
			try { type = ctx.vfs.stat(abs).type; } catch { return fail('ENOENT', -2, 'no such file or directory'); }
			if (type !== 'directory') fail('ENOTDIR', -20, 'not a directory');
			runCwd.value = abs;
		};
		/** A copy of a node context whose cwd stays live (a spread would freeze the getter). */
		const withLiveCwd = <T extends object>(o: T): T =>
			Object.defineProperty(o, 'cwd', { get: () => runCwd.value, enumerable: true, configurable: true });

		// A TypeScript run (its entry is .ts/.tsx/.mts/.cts/.jsx): files with those extensions have
		// their types stripped as they load, and relative imports also find them without an
		// extension or by their .js name, as TypeScript projects write them (Bun and tsx do too).
		const tsRun = needsTypeScript(filename);
		const jsxByDir = new Map<string, JsxOptions>();
		const jsxOptionsFor = (file: string): JsxOptions => {
			const start = dirname(file);
			const seen: string[] = [];
			let found: JsxOptions = {};
			for (let d = start; ; d = dirname(d)) {
				const cached = jsxByDir.get(d);
				if (cached) { found = cached; break; }
				seen.push(d);
				const tsconfig = join(d, 'tsconfig.json');
				if (ctx.vfs.exists(tsconfig)) {
					try { found = jsxOptionsFromTsconfig(ctx.vfs.readFileString(tsconfig)); } catch { /* unreadable: defaults */ }
					break;
				}
				if (dirname(d) === d) break;
			}
			for (const d of seen) jsxByDir.set(d, found);
			return found;
		};
		const fromTypeScript = (source: string, file: string): string =>
			needsTypeScript(file) ? stripTypes(source, file, jsxOptionsFor(file)) : source;

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
		// child_process.fork(): another node run in this box (the module, its args, env and cwd),
		// with an IPC channel to this one. Its output goes to this run's terminal ('inherit', the
		// default) or to pipes on the ChildProcess ('pipe' or `silent`). This run stays alive
		// while it runs, as a Node parent does while its child process is alive.
		let forkedChildren = 0;
		let nextForkPid = 1000;
		const forkNode = (modulePath: string, args: string[], options: ForkOptions): unknown => {
			const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
			const abort = new AbortController();
			const stopWithParent = () => abort.abort();
			ctx.signal.addEventListener('abort', stopWithParent, { once: true });
			let connected = true;
			let deliver: ((msg: unknown) => void) | null = null;
			const queued: unknown[] = [];
			const onDisconnect: Array<() => void> = [];
			const ipc: NodeIpc = {
				get connected() { return connected; },
				toParent: (msg) => { const copy = ipcCopy(msg); queueMicrotask(() => child.emit('message', copy)); },
				attach: (fn) => { deliver = fn; for (const msg of queued.splice(0)) queueMicrotask(() => fn(msg)); },
				onDisconnect: (fn) => { onDisconnect.push(fn); },
				disconnect: () => {
					if (!connected) return;
					connected = false;
					queueMicrotask(() => {
						child.emit('disconnect');
						for (const fn of onDisconnect) fn();
					});
				},
			};
			const stdio = options.silent ? 'pipe' : options.stdio ?? 'inherit';
			const piped = (fd: number) => stdio === 'pipe' || (Array.isArray(stdio) && stdio[fd] === 'pipe');
			const pipeStream = () => {
				const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
				let encoding: string | null = null;
				s.setEncoding = (enc: string) => { encoding = enc; return s; };
				s.pipe = (dest: { write(c: unknown): unknown }) => { s.on('data', (c: unknown) => dest.write(c)); return dest; };
				s.resume = () => s;
				s.pause = () => s;
				s.destroy = () => s;
				s.write = (text: string) => { s.emit('data', encoding ? text : Buffer.from(text)); return true; };
				return s;
			};
			const out = piped(1) ? pipeStream() : null;
			const err = piped(2) ? pipeStream() : null;
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(options.env ?? nodeCtx.env)) if (v !== undefined) env[k] = String(v);
			const childCtx: ForkedContext = {
				args: [modulePath, ...args],
				env,
				cwd: options.cwd ? resolve(runCwd.value, options.cwd) : runCwd.value,
				vfs: ctx.vfs,
				stdout: out ? { write: (t: string) => { (out.write as (t: string) => void)(t); } } : ctx.stdout,
				stderr: err ? { write: (t: string) => { (err.write as (t: string) => void)(t); } } : ctx.stderr,
				signal: abort.signal,
				executeCapture: ctx.executeCapture,
				executeCaptureResult: ctx.executeCaptureResult,
				runInherited: ctx.runInherited,
				[NODE_IPC]: ipc,
			};
			let killSignal: string | null = null;
			Object.assign(child, {
				pid: nextForkPid++,
				stdin: null,
				stdout: out,
				stderr: err,
				stdio: [null, out, err, null],
				exitCode: null,
				signalCode: null,
				killed: false,
				channel: { ref() {}, unref() {} },
				send: (msg: unknown, ...rest: unknown[]) => {
					const cb = rest.find((r): r is (e: Error | null) => void => typeof r === 'function');
					if (!connected) {
						const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
						queueMicrotask(() => (cb ? cb(e) : child.emit('error', e)));
						return false;
					}
					const copy = ipcCopy(msg);
					if (deliver) { const fn = deliver; queueMicrotask(() => fn(copy)); } else queued.push(copy);
					if (cb) queueMicrotask(() => cb(null));
					return true;
				},
				disconnect: () => ipc.disconnect(),
				kill: (signal: string | number = 'SIGTERM') => {
					if (child.exitCode !== null || killSignal) return false;
					killSignal = typeof signal === 'number' ? 'SIGTERM' : signal;
					child.killed = true;
					abort.abort();
					return true;
				},
				ref: () => child,
				unref: () => child,
			});
			Object.defineProperty(child, 'connected', { get: () => connected, enumerable: true });
			forkedChildren++;
			queueMicrotask(() => child.emit('spawn'));
			void Promise.resolve()
				.then(() => runNode(childCtx))
				.catch((e: unknown) => {
					// The run itself failed (not the program): say so rather than exit silently.
					childCtx.stderr.write(`[lifo] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
					return 1;
				})
				.then((code) => {
					forkedChildren--;
					ctx.signal.removeEventListener('abort', stopWithParent);
					ipc.disconnect();
					child.exitCode = killSignal ? null : code;
					child.signalCode = killSignal;
					out?.emit('end');
					err?.emit('end');
					queueMicrotask(() => {
						child.emit('exit', killSignal ? null : code, killSignal);
						child.emit('close', killSignal ? null : code, killSignal);
					});
				});
			return child;
		};

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
	const nodeCtx: NodeContext = withLiveCwd({
			vfs: ctx.vfs,
			cwd: ctx.cwd,
			chdir: chdirRun,
			// Copy the shell env once so the node run has its own process.env
			// (isolated from the shell) that is then shared across all its modules.
			// NAPI_RS_FORCE_WASI: a native addon (.node) can never load in a box, so napi-rs
			// loaders go straight to their wasm32-wasi build (node-compat/napi-wasi) instead of
			// probing every platform package first (and shelling out to `ldd` to detect musl).
			env: { NAPI_RS_FORCE_WASI: 'true', ...nativeFreeDefaults(filename, scriptArgs, ctx.env), ...ctx.env },
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
			// spawnSync / execSync with inherited output: run on this terminal once the program ends.
			runAfterExit: ctx.runInherited
				? (line, cwd) => { afterExit.push({ line, cwd: cwd ? resolve(runCwd.value, cwd) : runCwd.value }); }
				: undefined,
			forkNode,
		});

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
		// Loopback requests to a port bound in this VM (an API reading the tinbase
		// on localhost:54321) go to that in-VM server, not the real localhost.
		const proxying = typeof realFetch === 'function'
			? makeLoopbackFetch(portRegistry, makeProxyingFetch(realFetch.bind(globalThis), nodeCtx.env))
			: realFetch;
		const nodeFetch = (typeof proxying === 'function'
			? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					pendingAsync++;
					let p: Promise<Response>;
					try { p = proxying(input, init); } catch (e) { pendingAsync--; throw e; }
					return Promise.resolve(p).finally(() => { pendingAsync--; });
				})
			: proxying) as typeof fetch;

		// Pending work this run's program is waiting on (activity.ts): its timers and outgoing
		// HTTP requests report here, so the run can end as soon as the program is done instead
		// of waiting out a quiet period. One tracker per run: a dev server's intervals in
		// another run don't hold this one open.
		const activity = createActivityTracker();
		const runTimers = nodeTimers.createTimers(activity);
		nodeCtx.activity = activity;
		nodeCtx.timers = runTimers;
		trackWebAssembly();
		// A module's bare `setImmediate` is a lookup of the global in Node, so a program that
		// replaces globalThis.setImmediate changes it for every module: Next.js does, to run
		// React's rendering work inside each render stage. Until something replaces it, the
		// run's own (counted in its tracker) is used.
		const runSetImmediate = (...a: Parameters<typeof runTimers.setImmediate>) => {
			const replaced = (globalThis as Record<string, unknown>).setImmediate;
			return typeof replaced === 'function' && replaced !== REALM_SET_IMMEDIATE
				? (replaced as (...x: unknown[]) => unknown)(...a)
				: runTimers.setImmediate(...a);
		};
		const runClearImmediate = (t: unknown) => {
			runTimers.clearImmediate(t as Parameters<typeof runTimers.clearImmediate>[0]);
			const replaced = (globalThis as Record<string, unknown>).clearImmediate;
			if (typeof replaced === 'function' && replaced !== REALM_CLEAR_IMMEDIATE) (replaced as (x: unknown) => void)(t);
		};
		const timerGlobals = {
			setTimeout: runTimers.setTimeout,
			setInterval: runTimers.setInterval,
			setImmediate: runTimers.setImmediate,
			clearTimeout: runTimers.clearTimeout,
			clearInterval: runTimers.clearInterval,
			clearImmediate: runTimers.clearImmediate,
		};

		// Serve require('fetch-nodeshim') from the native fetch stack — see
		// makeFetchNodeshim. Built per-run so it uses this run's proxying fetch.
		const fetchNodeshim = typeof nodeFetch === 'function' ? makeFetchNodeshim(nodeFetch) : undefined;

		// @tailwindcss/oxide (Tailwind v4's native Rust Scanner) — served as a JS
		// shim over the VFS. Its native + threaded-wasm bindings can't load in the
		// browser VM. See createOxideScanner.
		const oxideModule = { Scanner: createOxideScanner(ctx.vfs) };

		// @swc/core (native Rust binding) — backed by the wasm esbuild shim, so
		// @vitejs/plugin-react-swc runs unmodified. See createSwcCore.
		const swcModule = createSwcCore({ vfs: ctx.vfs, cwd: ctx.cwd }, createEsbuild);

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

		// The run's process: what the main script sees and what `require('process')` /
		// `import { stdin } from 'node:process'` return, as in Node. The module map's own
		// entry builds a bare process whose stdin never receives input, so CLIs that import
		// stdin (create-vite's clack prompts) drew a prompt nobody could answer.
		const runProcess = createProcess({
			argv: nodeCtx.argv,
			env: nodeCtx.env,
			cwd: () => runCwd.value,
			chdir: chdirRun,
			stdout: runStdout,
			stderr: runStderr,
			stdin: nodeStdin,
			interactive,
			onExit: requestExit,
		});

		// A run started by child_process.fork(): process.send(), process.on('message'),
		// process.connected and process.disconnect() over its channel to the parent.
		const ipc = (ctx as ForkedContext)[NODE_IPC];
		if (ipc) {
			const proc = runProcess as unknown as Record<string, unknown> & { emit(event: string, ...a: unknown[]): boolean };
			Object.assign(proc, {
				send: (msg: unknown, ...rest: unknown[]) => {
					const cb = rest.find((r): r is (e: Error | null) => void => typeof r === 'function');
					if (!ipc.connected) {
						const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
						queueMicrotask(() => (cb ? cb(e) : proc.emit('error', e)));
						return false;
					}
					ipc.toParent(msg);
					if (cb) queueMicrotask(() => cb(null));
					return true;
				},
				disconnect: () => ipc.disconnect(),
				channel: { ref() {}, unref() {} },
			});
			Object.defineProperty(proc, 'connected', { get: () => ipc.connected, enumerable: true, configurable: true });
			ipc.attach((msg) => proc.emit('message', msg));
			ipc.onDisconnect(() => proc.emit('disconnect'));
		}
		// Node keeps a forked child alive while its channel is open and something listens on it.
		const ipcHoldsRun = () => !!ipc && ipc.connected &&
			(runProcess.listenerCount('message') + runProcess.listenerCount('disconnect')) > 0;

		const moduleMap = createModuleMap(nodeCtx);
		moduleMap.process = () => runProcess;
		const moduleCache = new Map<string, unknown>();

		// require.cache: a live view of the files in moduleCache, as Node's is of its loaded modules.
		// `delete require.cache[file]` makes the next require() run the file again, which is how
		// dev servers reload what they rebuilt (Next.js drops its server bundles and webpack
		// runtime after every compile; with a detached cache the old runtime kept serving and
		// never loaded the new chunks). Entries are Module-like records whose `exports` is the
		// cached value; assigning an entry puts a module in the cache.
		type CacheRecord = { id: string; filename: string; loaded: boolean; exports: unknown; children: CacheRecord[]; paths: string[]; parent: CacheRecord | null };
		const cacheRecords = new Map<string, CacheRecord>();
		const isFileKey = (key: string | symbol): key is string => typeof key === 'string' && key.startsWith('/');
		const cacheRecord = (file: string): CacheRecord => {
			let rec = cacheRecords.get(file);
			if (!rec) {
				rec = {
					id: file, filename: file, loaded: true, children: [], paths: [], parent: null,
					get exports() { return moduleCache.get(file); },
					set exports(v: unknown) { moduleCache.set(file, v); },
				};
				cacheRecords.set(file, rec);
			}
			return rec;
		};
		const requireCache = new Proxy(Object.create(null) as Record<string, CacheRecord>, {
			get: (_t, key) => (isFileKey(key) && moduleCache.has(key) ? cacheRecord(key) : undefined),
			has: (_t, key) => isFileKey(key) && moduleCache.has(key),
			set: (_t, key, value: { exports?: unknown } | undefined) => {
				if (!isFileKey(key)) return true;
				moduleCache.set(key, value?.exports);
				if (value && typeof value === 'object') cacheRecords.set(key, value as CacheRecord);
				return true;
			},
			deleteProperty: (_t, key) => {
				if (isFileKey(key)) { moduleCache.delete(key); cacheRecords.delete(key); }
				return true;
			},
			ownKeys: () => [...moduleCache.keys()].filter(isFileKey),
			getOwnPropertyDescriptor: (_t, key) => (isFileKey(key) && moduleCache.has(key)
				? { value: cacheRecord(key), writable: true, enumerable: true, configurable: true }
				: undefined),
		});

		// napi-rs wasm32-wasi addons (Rolldown, Oxc, ...): their generated loaders get a WASI
		// on the box's fs and real threads (node-compat/napi-wasi). Threads end with the run.
		const napiWasi = createNapiWasiRuntime({
			getFs: () => nodeRequire('fs') as Record<string, unknown>,
			env: nodeCtx.env,
			stdout: runStdout,
			stderr: runStderr,
			activity,
			readFile: (p) => ctx.vfs.readFileString(p),
			exists: (p) => ctx.vfs.exists(p),
			resolve: (spec, fromDir) => {
				const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
				if (moduleMap[bare]) return `builtin:${bare}`;
				if (spec.startsWith('#')) return resolvePackageImport(spec, fromDir)?.path ?? null;
				if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) return resolveVfsModule(spec, fromDir)?.path ?? null;
				return resolveNodeModule(spec, fromDir)?.path ?? null;
			},
			compile: (source, filename) => {
				let clean = stripShebang(source);
				clean = shouldTreatAsEsm(clean, filename, ctx.vfs) ? transformEsmToCjs(clean) : rewriteDynamicImports(clean);
				return `(function(${buildWrapperParams(clean)}) {\n${clean}\n})`;
			},
			// A wasm addon's bundled runtime (napi-wasi embeddedRuntimeSource), run in this box.
			evaluate: (source, filename) => executeModule(source, filename, filename),
		});

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

		// require.extensions (Module._extensions), one object for the whole run like Node's. Lifo's
		// loader doesn't dispatch through it, but tools read and wrap its loaders: Next.js keeps
		// `require.extensions['.js']` and calls it from its own hook when it loads next.config.ts.
		type ExtensionModule = { exports: unknown; _compile(code: string, filename: string): unknown };
		const requireExtensions: Record<string, (mod: ExtensionModule, filename: string) => void> = {
			'.js': (mod, filename) => { mod._compile(ctx.vfs.readFileString(filename), filename); },
			'.json': (mod, filename) => { mod.exports = JSON.parse(ctx.vfs.readFileString(filename)); },
			'.node': (_mod, filename) => { throw new Error(`Cannot load native addon ${filename} in a box`); },
		};

		/**
		 * module.createRequire(filename): a require that resolves from that file's directory, as in
		 * Node. Bundles declare their own `const require = createRequire(import.meta.url)` (Prettier
		 * does), and once their imports are requires too, every import goes through it. Lifo used to
		 * hand back the require of whichever module first loaded 'module' in the run, so a
		 * package's relative imports resolved from another package's directory.
		 */
		const SHIMMED_MODULES = new Set(['lightningcss', '@tailwindcss/oxide', '@swc/core', 'fetch-nodeshim', '@babel/core', 'rollup/parseAst', 'rollup/parseAst.js']);
		function createRequireAt(filename: string | URL, base: (name: string) => unknown, builtins: Record<string, unknown>): unknown {
			let file = typeof filename === 'string' ? filename : filename.href;
			if (file.startsWith('file://')) file = decodeURIComponent(file.slice('file://'.length));
			const fromDir = file.endsWith('/') ? file.replace(/\/+$/, '') || '/' : dirname(file);
			const req = (name: string): unknown => {
				let n = name.startsWith('node:') ? name.slice(5) : name;
				if (n.startsWith('file://')) n = decodeURIComponent(n.slice('file://'.length));
				if (n.startsWith('./') || n.startsWith('../') || n === '.' || n === '..') return base(resolve(fromDir, n));
				if (n.startsWith('/') || n.startsWith('#') || builtins[n] || SHIMMED_MODULES.has(n) || n.includes('--for-')) return base(n);
				const found = resolveNodeModule(n, fromDir);
				return base(found ? found.path : n);
			};
			return Object.assign(req, {
				resolve: Object.assign((id: string) => resolveRequirePath(id, fromDir), { paths: () => null }),
				cache: requireCache,
				extensions: requireExtensions,
			});
		}

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
			// @tailwindcss/oxide — JS Scanner shim (see oxideModule / createOxideScanner).
			if (name === '@tailwindcss/oxide') return oxideModule;
			// @swc/core — wasm-esbuild-backed shim (see swcModule / createSwcCore).
			if (name === '@swc/core') return swcModule;
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
				throw moduleNotFound(name);
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

				throw moduleNotFound(name);
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

			throw moduleNotFound(name);
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
		(nodeRequire as unknown as { cache: unknown }).cache = requireCache;
		(nodeRequire as unknown as { extensions: unknown }).extensions = requireExtensions;

		// Override module shim so createRequire returns nodeRequire (resolves VFS +
		// node_modules). Must stay a constructable Module class with a working
		// _compile: require-from-string does `new (require('module'))(...)` +
		// `m._compile(code)` (e.g. @expo/config evaluating app.config.js).
		moduleMap.module = () => {
			const builtinNames = Object.keys(moduleMap);
			return createModuleClass(
				{ executeCjs: nodeCtx.executeCjs },
				{
					createRequire: (filename: string | URL) => createRequireAt(filename, nodeRequire, moduleMap),
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
					for (const ext of tsRun ? TS_RUN_EXTENSIONS : ['.js', '.mjs', '.cjs', '.json']) {
						const indexPath = join(absPath, 'index' + ext);
						if (ctx.vfs.exists(indexPath)) return { path: indexPath };
					}
				} catch { /* fall through */ }
			}

			// Append extensions when the exact path doesn't resolve. Node does
			// this regardless of dots in the specifier, so a require of
			// './webauthn.errors' must still find 'webauthn.errors.js'.
			for (const ext of tsRun ? TS_RUN_EXTENSIONS : ['.js', '.mjs', '.cjs', '.json']) {
				if (ctx.vfs.exists(absPath + ext)) return { path: absPath + ext };
			}
			// TypeScript imports a sibling by its compiled name: './util.js' is util.ts.
			if (tsRun) {
				const m = /\.(m|c)?jsx?$/.exec(absPath);
				if (m) {
					const base = absPath.slice(0, m.index);
					for (const ext of m[0].endsWith('x') ? ['.tsx'] : [`.${m[1] ?? ''}ts`, ...(m[1] ? [] : ['.tsx'])]) {
						if (ctx.vfs.exists(base + ext)) return { path: base + ext };
					}
				}
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

		/**
		 * Resolve a conditional exports value (string | array | { condition: value }). Node picks the
		 * first key, in the object's own order, that is one of its conditions for require()
		 * ("require", "node", "default"), recursing into nested objects: TanStack Router's
		 * "./isServer" lists development, workerd, worker, browser, deno, node, … and Node takes
		 * "node" (server: true). Only when nothing matches does Lifo fall back to other
		 * conditions ("browser", non-standard ones), and to "import" last: a dual package like
		 * signal-exit lists "import" first, and an ESM file in a CJS require is the worse choice.
		 */
		const REQUIRE_CONDITIONS = new Set(['require', 'node', 'default']);
		function matchExports(value: unknown, strict: boolean): string | null {
			if (typeof value === 'string') return value;
			if (Array.isArray(value)) {
				for (const v of value) {
					const r = matchExports(v, strict);
					if (r) return r;
				}
				return null;
			}
			if (!value || typeof value !== 'object') return null;
			const cond = value as Record<string, unknown>;
			for (const key of Object.keys(cond)) {
				if (!REQUIRE_CONDITIONS.has(key)) continue;
				const r = matchExports(cond[key], strict);
				if (r) return r;
			}
			if (strict) return null;
			if ('browser' in cond) {
				const r = matchExports(cond.browser, false);
				if (r) return r;
			}
			for (const key of Object.keys(cond)) {
				if (key === 'types' || key === 'import' || key === 'browser' || REQUIRE_CONDITIONS.has(key)) continue;
				const r = matchExports(cond[key], false);
				if (r) return r;
			}
			return 'import' in cond ? matchExports(cond.import, false) : null;
		}
		function resolveExportsCondition(value: unknown): string | null {
			return matchExports(value, true) ?? matchExports(value, false);
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

			const modNodeCtx: NodeContext = withLiveCwd({ ...nodeCtx, filename: modFilename, dirname: modDir });
			const modModuleMap = createModuleMap(modNodeCtx);
			modModuleMap.process = () => runProcess;
			// One process for the whole program, as in Node: a listener one module adds, or a
			// method it replaces (Next.js patches process.nextTick), is seen by every module.
			const modProcess = runProcess;
			const modConsole = createConsole(runStdout, runStderr);

			// A napi-rs wasm32-wasi loader gets Lifo's `wasi` and `worker_threads` (see
			// node-compat/napi-wasi). Built on first require, which throws when this host
			// can't run wasm threads, before the loader allocates its shared memory.
			const isWasiLoader = isNapiWasiLoader(modSource);
			let wasiLoaderModules: { wasi: unknown; worker_threads: unknown } | null = null;

			function modRequire(name: string): unknown {
				// Strip node: prefix
				if (name.startsWith('node:')) name = name.slice(5);
				if (isWasiLoader && (name === 'wasi' || name === 'worker_threads')) {
					wasiLoaderModules ??= napiWasi.modulesFor(modFilename, modRequire);
					return wasiLoaderModules[name];
				}
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
			// @tailwindcss/oxide — JS Scanner shim (see oxideModule / createOxideScanner).
			if (name === '@tailwindcss/oxide') return oxideModule;
			// @swc/core — wasm-esbuild-backed shim (see swcModule / createSwcCore).
			if (name === '@swc/core') return swcModule;
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
					throw moduleNotFound(name);
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
					throw moduleNotFound(name);
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

				throw moduleNotFound(name);
			}

			// require.resolve for child modules (resolves relative to this module).
			(modRequire as unknown as { resolve: unknown }).resolve = Object.assign(
				(id: string) => resolveRequirePath(id, modDir),
				{ paths: () => null },
			);
			(modRequire as unknown as { cache: unknown }).cache = requireCache;
			(modRequire as unknown as { extensions: unknown }).extensions = requireExtensions;

			// Override module shim so createRequire returns modRequire (resolves VFS + node_modules too)
			// Same as the main map's override: a constructable Module class whose
			// createRequire is this module's scoped require.
			modModuleMap.module = () => {
				const builtinNames = Object.keys(modModuleMap);
				return createModuleClass(
					{ executeCjs: nodeCtx.executeCjs },
					{
						createRequire: (filename: string | URL) => createRequireAt(filename, modRequire, modModuleMap),
						builtinModules: builtinNames,
						isBuiltin: (s: string) => {
							const n = s.startsWith('node:') ? s.slice(5) : s;
							return builtinNames.includes(n);
						},
						...moduleResolveExtras(modDir),
					},
				);
			};

			// A few packages' code is adjusted for a box as it loads (package-adapters.ts).
			let cleanSource = fromTypeScript(stripShebang(adaptPackageSource(modFilename, modSource)), modFilename);
			const isEsModule = shouldTreatAsEsm(cleanSource, modFilename, ctx.vfs);
			if (isEsModule) {
				cleanSource = transformEsmToCjs(cleanSource);
			} else {
				// CJS modules skip transformEsmToCjs, but still may use dynamic import()
				// (e.g. pglite's index.cjs → import('fs/promises')). Rewrite those too.
				cleanSource = rewriteDynamicImports(cleanSource);
			}
			// Carry AsyncLocalStorage's stores across this module's awaits (await-context.ts).
			cleanSource = instrumentAwaits(cleanSource);
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
			const global = makeNodeGlobal({ process: modProcess, Buffer, console: modConsole, ...timerGlobals });
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
					runTimers.setTimeout as unknown as typeof setTimeout, runTimers.setInterval as unknown as typeof setInterval,
					runTimers.clearTimeout as unknown as typeof clearTimeout, runTimers.clearInterval as unknown as typeof clearInterval,
					global,
					importMetaUrl, importMeta, importMetaResolve,
					// window/document/self undefined: node-executed code must see a Node
					// environment (no DOM), matching real Node — e.g. so Emscripten
					// (pglite) doesn't mis-detect the browser and mis-resolve data files.
					undefined, undefined, undefined, NODE_NAVIGATOR,
					nodeFetch, // fetch (CORS-proxied for known hosts)
					runSetImmediate, runClearImmediate,
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

			// The addon's async calls (bundle.generate(), ...) run on its threads, out of the
			// run's sight: count them so `vite build` isn't ended mid-bundle.
			if (wasiLoaderModules) napiWasi.trackExports(modModule.exports);

			// require() of an ES module, as Node 22.12+ returns it: marked __esModule when it has a
			// default export, so bundled CommonJS (esbuild's __toESM, Babel's interop) takes that
			// default. Tailwind's CJS build does `new (__toESM(require('magic-string')).default)()`
			// with magic-string 1.x, which is ESM only.
			const esmExports = modModule.exports as Record<string, unknown> | null;
			if (isEsModule && esmExports && typeof esmExports === 'object' && 'default' in esmExports && !('__esModule' in esmExports)) {
				try { Object.defineProperty(esmExports, '__esModule', { value: true, configurable: true }); } catch { /* frozen */ }
			}

			return modModule.exports;
		}

		// Execute main script
		const process = runProcess;
		const nodeConsole = createConsole(runStdout, runStderr);

		const module = { exports: {} as Record<string, unknown> };
		const exports = module.exports;
		const global = makeNodeGlobal({ process, Buffer, console: nodeConsole, ...timerGlobals });

		let cleanMainSource = fromTypeScript(stripShebang(source), filename);
		const isEsm = shouldTreatAsEsm(cleanMainSource, filename, ctx.vfs);
		if (isEsm) {
			cleanMainSource = transformEsmToCjs(cleanMainSource);
		}
		cleanMainSource = instrumentAwaits(cleanMainSource);

		// Use async IIFE for ESM (supports top-level await)
		const wrapped = isEsm
			// The same parameters as CommonJS (fetch included, so an ES module's loopback
			// fetch reaches servers in this box, not the host's localhost).
			? `(async function(${buildWrapperParams(cleanMainSource)}) {\n${cleanMainSource}\n})`
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
		// Turn a rejection reason into something useful. Plain objects and errors
		// that carry codes but no message/stack (e.g. Emscripten `ErrnoError`
		// {name, errno} from PGlite/wasm) otherwise stringify to "[object Object]"
		// or an empty stack.
		const describeRejection = (reason: unknown): string => {
			const r = reason as Record<string, unknown> | null;
			if (r && typeof r === 'object') {
				const extra: string[] = [];
				for (const k of ['code', 'errno', 'syscall', 'path']) {
					if (r[k] != null) extra.push(`${k}=${String(r[k])}`);
				}
				const tag = extra.length ? ` (${extra.join(', ')})` : '';
				if (typeof r.stack === 'string' && r.stack) return r.stack + tag;
				if (r.message != null) return `${String(r.name ?? 'Error')}: ${String(r.message)}${tag}`;
				if (r.name != null || extra.length) return `${String(r.name ?? 'Error')}${tag}`;
				try { return JSON.stringify(reason); } catch { /* circular */ }
			}
			return String(reason);
		};

		const rejectionHandler = (event: PromiseRejectionEvent) => {
			pendingRejection = event.reason;
			event.preventDefault(); // prevent browser default logging
			if (event.reason instanceof ProcessExitError) {
				signalExit();
			} else if (!isWasmThreadsUnavailable(event.reason)) {
				ctx.stderr.write(`[unhandledRejection] ${describeRejection(event.reason)}\n`);
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
				runTimers.setTimeout as unknown as typeof setTimeout, runTimers.setInterval as unknown as typeof setInterval,
				runTimers.clearTimeout as unknown as typeof clearTimeout, runTimers.clearInterval as unknown as typeof clearInterval,
				global,
				mainImportMetaUrl, mainImportMeta, mainImportMetaResolve,
				undefined, undefined, undefined, NODE_NAVIGATOR,
				nodeFetch, // fetch (CORS-proxied for known hosts)
				runSetImmediate, runClearImmediate,
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

			// Keep the run alive while the program still has work pending, like Node's event
			// loop: ref'd timers, outgoing HTTP requests and fetches, child processes, modules
			// still loading, WebAssembly compiling (activity.ts). With none of that pending the
			// script is done, and the run ends after a short grace for promise chains on work we
			// can't see. Ends early when a server starts (-> server race below), process.exit()
			// fires, or the run aborts.
			//
			// Interactive input is the exception. A prompt waiting for a keypress looks idle, and
			// a finished CLI can leave a stray keypress listener behind (create-expo-app), so
			// "is something reading stdin" can't decide it. A readline interface open on the
			// terminal can: prompt libraries open one per question and close it once answered,
			// so wait on it as long as the person takes (create-vite's clack prompts were cut
			// off after 500 ms). Any other stdin consumer falls back to waiting for a quiet
			// period (input counts as activity), as before.
			if (!activeServers || activeServers.length === 0) {
				const QUICK_GRACE_MS = 60;
				let prevCacheSize = moduleCache.size;
				let lastInputSeq = (nodeStdin as unknown as { inputSeq?: number }).inputSeq ?? 0;
				let lastWorkMs = 0; // ms since the loop started when work last happened
				let elapsed = 0;
				const startedAt = Date.now();
				let hardDeadline = startedAt + 600000; // 10 min cap (long installs)
				while (Date.now() < hardDeadline) {
					const stdinInUse = nodeStdin.isActive();
					const tickMs = stdinInUse ? 50 : 15;
					const tick = await Promise.race([
						new Promise<'tick'>((r) => setTimeout(() => r('tick'), tickMs)),
						exitPromise.then(() => 'exit' as const),
					]);
					if (tick === 'exit' || ctx.signal.aborted || pendingRejection || asyncExitCode !== null) break;
					elapsed = Date.now() - startedAt;
					activeServers = getActiveServers();
					if (activeServers && activeServers.length > 0) break;
					const seq = (nodeStdin as unknown as { inputSeq?: number }).inputSeq ?? 0;
					const pending = pendingAsync + pendingChild + activity.pending() + pendingWasm();
					if (pending > 0 || moduleCache.size > prevCacheSize || seq !== lastInputSeq) {
						lastWorkMs = elapsed;
						prevCacheSize = moduleCache.size;
						lastInputSeq = seq;
					}
					if (pending > 0) continue;
					// A prompt waiting for an answer, a child process started with fork(), or (in
					// that child) a parent it listens to: wait as long as they take.
					if (nodeStdin.isPrompting() || forkedChildren > 0 || ipcHoldsRun()) {
						lastWorkMs = elapsed;
						hardDeadline = Date.now() + 600000;
						continue;
					}
					const idleMs = elapsed - lastWorkMs;
					// A reader on stdin: the old quiet-period rule (longer for CJS, which has no
					// "main finished" signal, so a slow-to-answer prompt isn't cut short).
					const grace = stdinInUse ? (mainResolved ? 500 : 2500) : QUICK_GRACE_MS;
					if (idleMs >= grace) break;
				}
			}

			if (asyncExitCode !== null) return asyncExitCode;

			if (activeServers && activeServers.length > 0) {
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

				// Like Node, the run lasts while any server listens. The list is live: a server
				// that starts while we wait (Vite opens a short-lived one before its dev server)
				// joins it, so waiting only for the servers present at first ended the run as soon
				// as that early one closed, with the dev server still up.
				for (;;) {
					const serverPromises = activeServers
						.map((s) => s.getPromise())
						.filter((p): p is Promise<void> => p !== null);
					if (serverPromises.length === 0) break;

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
						break;
					}
					activeServers = getActiveServers() ?? [];
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
			// A wasm addon this host can't run: its one-line explanation is already on stderr.
			if (isWasmThreadsUnavailable(e)) return 1;
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
			// Host threads of wasm addons (napi-wasi) don't outlive the run that started them.
			napiWasi.dispose();
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
