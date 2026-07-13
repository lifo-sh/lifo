import { describe, it, expect } from 'vitest';
import { lex } from '../../src/shell/lexer.js';
import { TokenKind } from '../../src/shell/types.js';
import { complete, type CompletionContext } from '../../src/shell/completer.js';

function mockCtx(line: string): CompletionContext {
  const vfs = {
    readdir: () => [
      { name: '(archive)', type: 'directory' as const },
      { name: 'my project', type: 'directory' as const },
      { name: 'readme.md', type: 'file' as const },
      { name: 'src', type: 'directory' as const },
    ],
  };
  return {
    line, cursorPos: line.length, cwd: '/home/user', env: { HOME: '/home/user' },
    vfs: vfs as never, registry: { list: () => ['cd', 'ls', 'echo'] } as never,
    builtinNames: ['cd', 'ls'],
  };
}

// word values the execution lexer produces (drops EOF)
function words(input: string): string[] {
  return lex(input).filter((t) => t.kind === TokenKind.Word).map((t) => t.value);
}

describe('completer — special chars are escaped', () => {
  it('completes a "(" dir into a shell-escaped, runnable path', () => {
    const r = complete(mockCtx('cd ('));
    expect(r.completions).toEqual(['\\(archive\\)/']);
    expect(r.replacementStart).toBe(3);
  });

  it('matches when the user pre-escaped the paren (cd \\()', () => {
    const r = complete(mockCtx('cd \\('));
    expect(r.completions).toEqual(['\\(archive\\)/']);
  });

  it('escapes spaces in names too', () => {
    const r = complete(mockCtx('cd my'));
    expect(r.completions).toEqual(['my\\ project/']);
  });

  it('escapes special chars even in a bare directory listing', () => {
    const r = complete(mockCtx('cd '));
    expect(r.completions).toContain('\\(archive\\)/');
    expect(r.completions).toContain('src/');
  });

  it('leaves ordinary names untouched', () => {
    const r = complete(mockCtx('ls read'));
    expect(r.completions).toEqual(['readme.md']);
  });
});

describe('completer — lexer round-trip', () => {
  // The escaped completion must lex back to the real filename (not a subshell).
  it('cd \\(archive\\)/ lexes to the (archive)/ path', () => {
    expect(words('cd \\(archive\\)/')).toEqual(['cd', '(archive)/']);
  });

  it('cd my\\ project/ lexes to the "my project/" path', () => {
    expect(words('cd my\\ project/')).toEqual(['cd', 'my project/']);
  });
});
