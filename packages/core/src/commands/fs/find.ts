import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { globMatch } from '../../utils/glob.js';
import { VFSError } from '../../kernel/vfs/index.js';

/** A file entry the predicate is evaluated against. */
interface Entry {
  name: string;
  type: string; // 'file' | 'directory' | 'symlink'
}

type Pred = (e: Entry) => boolean;

/**
 * Parse a find expression (subset): `( )` grouping, `-o` (OR), implicit AND,
 * `-type f|d|l`, `-name`/`-iname` (glob, iname case-insensitive), `!`/`-not`.
 * Unknown flags are treated as always-true so we don't reject unfamiliar tests.
 * Metro's node crawler drives this: `( ( -type f ( -iname *.js -o … ) ) -o -type l )`.
 */
function parseExpression(tokens: string[]): Pred {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseTerm = (): Pred => {
    const t = peek();
    if (t === '(') {
      next();
      const inner = parseOr();
      if (peek() === ')') next();
      return inner;
    }
    if (t === '!' || t === '-not') {
      next();
      const inner = parseTerm();
      return (e) => !inner(e);
    }
    if (t === '-type') {
      next();
      const kind = next();
      return (e) => (kind === 'f' ? e.type === 'file' : kind === 'd' ? e.type === 'directory' : kind === 'l' ? e.type === 'symlink' : true);
    }
    if (t === '-name' || t === '-iname') {
      const ci = t === '-iname';
      next();
      const pat = next() ?? '';
      return (e) => globMatch(ci ? pat.toLowerCase() : pat, ci ? e.name.toLowerCase() : e.name);
    }
    // Unknown flag: consume its value if it looks like it takes one, treat as true.
    next();
    if (peek() && !peek().startsWith('-') && peek() !== ')' && peek() !== '(' && peek() !== '-o') next();
    return () => true;
  };

  const parseAnd = (): Pred => {
    let pred = parseTerm();
    while (pos < tokens.length && peek() !== '-o' && peek() !== ')') {
      if (peek() === '-a') next();
      const rhs = parseTerm();
      const lhs = pred;
      pred = (e) => lhs(e) && rhs(e);
    }
    return pred;
  };

  function parseOr(): Pred {
    let pred = parseAnd();
    while (peek() === '-o') {
      next();
      const rhs = parseAnd();
      const lhs = pred;
      pred = (e) => lhs(e) || rhs(e);
    }
    return pred;
  }

  if (tokens.length === 0) return () => true;
  return parseOr();
}

const command: Command = async (ctx) => {
  const roots: string[] = [];
  let maxDepth = Infinity;
  const exprTokens: string[] = [];

  // Roots come first (paths), then the expression. Also pull out -maxdepth
  // (affects traversal, not the predicate).
  let i = 0;
  for (; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '' ) continue; // expression.split(' ') can yield empties
    if (a === '(' || a.startsWith('-')) break;
    roots.push(a);
  }
  for (; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '') continue;
    if (a === '-maxdepth') { maxDepth = parseInt(ctx.args[++i] ?? '', 10) || Infinity; continue; }
    exprTokens.push(a);
  }
  if (roots.length === 0) roots.push('.');

  const pred = parseExpression(exprTokens);

  const emit = (fullPath: string, e: Entry) => {
    if (pred(e)) ctx.stdout.write(fullPath + '\n');
  };

  const walk = (dirPath: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Entry[];
    try {
      entries = ctx.vfs.readdir(dirPath) as Entry[];
    } catch {
      return; // skip inaccessible dirs
    }
    for (const entry of entries) {
      const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
      emit(fullPath, entry);
      if (entry.type === 'directory') walk(fullPath, depth + 1);
    }
  };

  let exitCode = 0;
  for (const root of roots) {
    const absPath = resolve(ctx.cwd, root);
    try {
      const stat = ctx.vfs.stat(absPath);
      // find prints the root itself too (tested against the predicate).
      emit(absPath, { name: absPath.slice(absPath.lastIndexOf('/') + 1), type: stat.type });
      if (stat.type === 'directory') walk(absPath, 1);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`find: '${root}': ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }
  return exitCode;
};

export default command;
