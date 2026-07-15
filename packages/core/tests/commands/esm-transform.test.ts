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
});
