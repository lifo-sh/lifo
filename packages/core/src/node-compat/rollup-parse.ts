/**
 * Shim for `rollup/parseAst` backed by acorn.
 *
 * Rollup 4's parseAst is a native (NAPI) binding that can't run in the
 * browser. Vite's DEV server only calls it on small, already-transformed
 * code fragments (CJS-interop import rewriting in vite:import-analysis),
 * which acorn — the ESTree reference parser, pure JS and synchronous —
 * handles identically. `vite build` (full rollup) remains out of scope.
 */

import { parse } from 'acorn';

interface ParseAstOptions {
	allowReturnOutsideFunction?: boolean;
	jsx?: boolean;
}

function parseAst(code: string, opts?: ParseAstOptions): unknown {
	// jsx is not supported by base acorn, but vite parses code AFTER the
	// esbuild transform, so no JSX remains by the time parseAst runs.
	return parse(code, {
		ecmaVersion: 'latest',
		sourceType: 'module',
		allowReturnOutsideFunction: opts?.allowReturnOutsideFunction ?? false,
		allowHashBang: true,
	});
}

export function createRollupParseShim(): Record<string, unknown> {
	return {
		parseAst,
		parseAstAsync: async (code: string, opts?: ParseAstOptions) => parseAst(code, opts),
	};
}
