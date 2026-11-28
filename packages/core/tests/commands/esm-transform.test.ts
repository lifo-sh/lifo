import { describe, it, expect } from 'vitest';
import { transformEsmToCjs } from '../../src/commands/system/node.js';

// Ensure the transformed output has no ESM `import`/`export` statement syntax
// left (which would throw "Cannot use import statement outside a module" when
// run in the CJS wrapper).
function noEsmSyntax(out: string): boolean {
  return !out.split('\n').some(
    (l) => /^\s*import\s+[\w${*{]/.test(l) && /from\s*['"]/.test(l),
  ) && !/(^|\n)\s*export\s+(default|const|let|var|function|class|\{)/.test(out);
}

describe('transformEsmToCjs', () => {
  it('re-exports a namespace under one name (export * as X from)', () => {
    // yoctocolors' index.js, which execa loads.
    const out = transformEsmToCjs(`export * from './base.js';\nexport * as default from './base.js';\nexport * as 'odd name' from "./x.js";`);
    expect(out).not.toMatch(/export\s*\*/);
    const exports: Record<string, unknown> = {};
    const base = { red: () => 'r' };
    const x = { y: 1 };
    new Function('exports', 'require', out)(exports, (m: string) => (m === './base.js' ? base : x));
    expect(exports.red).toBe(base.red);
    expect(exports.default).toBe(base);
    expect(exports['odd name']).toBe(x);
  });

  it('transforms a plain default + named imports', () => {
    const out = transformEsmToCjs(`import fs from "fs/promises";\nimport { a, b as c } from "m";\nexport const x = 1;`);
    expect(out).toContain('require("fs/promises")');
    expect(out).toContain('require("m")');
    expect(noEsmSyntax(out)).toBe(true);
  });

  it('does not desync on a regex that follows a // comment (prettier repro)', () => {
    // The regex is on its own line after a comment whose last char is a digit.
    // Previously isRegexStart saw the comment text, misread the regex as
    // division, left it unmasked, and its inner quotes swallowed later code —
    // so the trailing import survived untransformed.
    const src = [
      'const f = (message) => message.replace(',
      '  // TODO[engine:node@>=20]: quoted after Node.js 20',
      "  /(?<=^Unexpected token )(['\"])/,",
      '  "$1",',
      ');',
      'import fs3 from "fs/promises";',
      'export { f };',
    ].join('\n');
    const out = transformEsmToCjs(src);
    expect(out).toContain('require("fs/promises")');
    expect(noEsmSyntax(out)).toBe(true);
  });

  it('validates regex flags — /[\\p{L}]/u is masked, not treated as code', () => {
    const src = [
      'const re = /[\\p{L}"\']/u;',
      'import x from "y";',
    ].join('\n');
    const out = transformEsmToCjs(src);
    expect(out).toContain('require("y")');
    expect(noEsmSyntax(out)).toBe(true);
  });

  it('treats division after a value as division, not a regex', () => {
    // `a) / b / c` must not be masked as a regex (which would swallow later code).
    const src = [
      'function g(a, b, c){ return (a) / b / c }',
      'import z from "w";',
      'export default g;',
    ].join('\n');
    const out = transformEsmToCjs(src);
    expect(out).toContain('require("w")');
    expect(noEsmSyntax(out)).toBe(true);
  });

  // A regex literal inside a ${...} expression used to throw
  // "Cannot read properties of undefined (reading 'slice')" — scanBracedExpr
  // called isRegexStart() with the wrong arguments. This is the exact shape in
  // tinbase's pgmem engine and pg-mem, so `npx tinbase --engine pgmem` died.
  it('handles a regex literal inside a ${...} template expression', () => {
    const src = [
      'export function q(labels) {',
      "  return `enum (${labels.map((l) => `'${l.replace(/'/g, \"''\")}'`).join(', ')})`;",
      '}',
      'import x from "y";',
    ].join('\n');
    const out = transformEsmToCjs(src);
    expect(out).toContain('require("y")');
    expect(noEsmSyntax(out)).toBe(true);
  });

  it('handles division inside a ${...} template expression', () => {
    const src = [
      'const s = `${a / b} and ${c / d}`;',
      'import x from "y";',
      'export { s };',
    ].join('\n');
    const out = transformEsmToCjs(src);
    expect(out).toContain('require("y")');
    expect(noEsmSyntax(out)).toBe(true);
  });
});

describe('transformEsmToCjs: wrapper-parameter names (Vite 8, oxc-parser)', () => {
	it('leaves a nested `let exports` alone instead of hoisting it as var', () => {
		// Vite 8's module-runner: a block-scoped `exports` inside an `if`, and another one in
		// the enclosing method. As `var` the inner one clashed with the outer `let`.
		const src = [
			'export class Runner {',
			'\tasync run(r) {',
			'\t\tif (r.ext) {',
			'\t\t\tlet exports = await r.load();',
			'\t\t\treturn exports;',
			'\t\t}',
			'\t\tlet meta = 1, exports = Object.create(null);',
			'\t\treturn exports;',
			'\t}',
			'}',
		].join('\n');
		const out = transformEsmToCjs(src);
		expect(out).toContain('let exports = await r.load();');
		expect(() => new Function('exports', 'require', 'module', out)).not.toThrow();
	});

	it('still turns a module-level declaration of a wrapper name into var', () => {
		const out = transformEsmToCjs('const __dirname = "/x";\nexport const a = __dirname;');
		expect(out).toContain('var __dirname = "/x"');
		expect(() => new Function('exports', 'require', 'module', '__filename', '__dirname', out)).not.toThrow();
	});

	it('handles a trailing comma in `export { … } from`', () => {
		const out = transformEsmToCjs('export {\n  ParseResult,\n  Severity,\n} from "./bindings.js";');
		expect(out).not.toContain("exports, ''");
		expect(out).toContain("'Severity'");
		expect(() => new Function('exports', 'require', 'module', out)).not.toThrow();
	});
});
