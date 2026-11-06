import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';
import { posixToJs } from './sed.js';

/*
 * A small awk: a tokenizer, a recursive-descent parser for awk's expression
 * grammar (assignment, ?:, || && ! ~ comparisons, concatenation, arithmetic,
 * ^, ++/--, $field) and the common statements (print/printf with > / >>,
 * if/else, while, do … while, for(;;), for (k in a), break/continue/next/exit,
 * blocks), plus BEGIN/END, /regex/, expression and range patterns, and the
 * usual string builtins.
 *
 * Associative arrays: a[k], a[i,j] (keys joined with SUBSEP), (k in a),
 * (i,j) in a, delete a[k], delete a, split(s, a [, sep]), length(a).
 * `for (k in a)` visits keys in insertion order (gawk's order is unspecified,
 * so scripts cannot depend on it either way).
 *
 * User-defined functions: `function f(a, b,   locals) { … return x }`. Arrays
 * are passed by reference, scalars by value, missing arguments are locals,
 * and an untyped variable passed in becomes an array in the caller if the
 * function uses it as one.
 *
 * getline: `getline`, `getline var` (next main-input record), `getline < file`,
 * `getline var < file`, and close(file).
 *
 * Numbers convert to strings with CONVFMT (keys, concatenation) and print
 * with OFMT; both default to "%.6g", integers print as integers.
 *
 * Not supported (reported as an error rather than silently mis-evaluated):
 * `print | cmd`, `cmd | getline`, system().
 */

class AwkError extends Error {}

type V = string | number;

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'regex'; v: string }
  | { t: 'name'; v: string }
  | { t: 'func'; v: string }
  | { t: 'ufunc'; v: string }
  | { t: 'op'; v: string }
  | { t: 'nl' }
  | { t: 'eof' };

const KEYWORDS = new Set([
  'BEGIN', 'END', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile',
  'exit', 'print', 'printf', 'getline', 'function', 'func', 'return', 'delete', 'in',
]);
const BUILTINS = new Set([
  'length', 'substr', 'index', 'toupper', 'tolower', 'sprintf', 'int', 'sqrt', 'exp', 'log',
  'sin', 'cos', 'atan2', 'rand', 'srand', 'sub', 'gsub', 'match', 'split', 'system', 'close',
]);
const OPS = [
  '+=', '-=', '*=', '/=', '%=', '^=', '**', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~',
  '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$', '(', ')', '{', '}', '[', ']', ';', ',', '=',
];

function unescapeString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[++i];
    if (n === undefined) { out += '\\'; break; }
    if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b', f: '\f', v: '\v' };
    out += map[n] ?? '\\' + n;
  }
  return out;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const operandEnd = () => {
    const p = toks[toks.length - 1];
    if (!p) return false;
    if (p.t === 'num' || p.t === 'str' || p.t === 'regex' || p.t === 'name') return !KEYWORDS.has((p as { v: string }).v) || (p as { v: string }).v === 'getline';
    return p.t === 'op' && (p.v === ')' || p.v === ']' || p.v === '$' || p.v === '++' || p.v === '--');
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\n') { toks.push({ t: 'nl' }); i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { raw += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === '\n') throw new AwkError('newline in string');
        raw += src[j++];
      }
      if (src[j] !== '"') throw new AwkError('unterminated string');
      toks.push({ t: 'str', v: unescapeString(raw) });
      i = j + 1;
      continue;
    }
    if (c === '/' && !operandEnd()) {
      let j = i + 1;
      let raw = '';
      let inBracket = false;
      while (j < src.length && (src[j] !== '/' || inBracket)) {
        if (src[j] === '\n') throw new AwkError('newline in regex');
        if (src[j] === '\\' && j + 1 < src.length) {
          raw += src[j + 1] === '/' ? '/' : src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '[') inBracket = true;
        else if (src[j] === ']') inBracket = false;
        raw += src[j++];
      }
      if (src[j] !== '/') throw new AwkError('unterminated regex');
      toks.push({ t: 'regex', v: raw });
      i = j + 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)/.exec(src.slice(i))!;
      toks.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      const name = m[0];
      i += name.length;
      if (BUILTINS.has(name) && src[i] === '(') toks.push({ t: 'func', v: name });
      else if (name === 'length') toks.push({ t: 'func', v: name }); // bare `length`
      else if (!KEYWORDS.has(name) && src[i] === '(') toks.push({ t: 'ufunc', v: name }); // f(…)
      else toks.push({ t: 'name', v: name });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new AwkError(`syntax error at '${c}'`);
    toks.push({ t: 'op', v: op === '**' ? '^' : op });
    i += op.length;
  }
  toks.push({ t: 'eof' });
  return toks;
}

// ── AST ────────────────────────────────────────────────────────────────────

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'regex'; v: string }
  | { k: 'var'; name: string }
  | { k: 'index'; name: string; subs: Node[] }
  | { k: 'in'; subs: Node[]; name: string }
  | { k: 'field'; e: Node }
  | { k: 'group'; e: Node }
  | { k: 'list'; items: Node[] }
  | { k: 'assign'; op: string; target: Node; e: Node }
  | { k: 'cond'; c: Node; a: Node; b: Node }
  | { k: 'or' | 'and'; l: Node; r: Node }
  | { k: 'not'; e: Node }
  | { k: 'neg' | 'pos'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'cmp'; op: string; l: Node; r: Node }
  | { k: 'match'; neg: boolean; l: Node; r: Node }
  | { k: 'concat'; l: Node; r: Node }
  | { k: 'incdec'; op: '++' | '--'; pre: boolean; target: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'ucall'; name: string; args: Node[] }
  | { k: 'getline'; target?: Node; file?: Node };

type Redirect = { mode: '>' | '>>'; target: Node };

type Stmt =
  | { k: 'print'; args: Node[]; redir?: Redirect }
  | { k: 'printf'; args: Node[]; redir?: Redirect }
  | { k: 'expr'; e: Node }
  | { k: 'if'; c: Node; then: Stmt; else?: Stmt }
  | { k: 'while'; c: Node; body: Stmt }
  | { k: 'do'; body: Stmt; c: Node }
  | { k: 'forin'; v: string; arr: string; body: Stmt }
  | { k: 'delete'; name: string; subs?: Node[] }
  | { k: 'return'; e?: Node }
  | { k: 'for'; init?: Node; c?: Node; step?: Node; body: Stmt }
  | { k: 'block'; body: Stmt[] }
  | { k: 'next' }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'exit'; e?: Node };

type Pattern =
  | { k: 'BEGIN' }
  | { k: 'END' }
  | { k: 'all' }
  | { k: 'expr'; e: Node }
  | { k: 'range'; from: Node; to: Node; active: boolean };

interface Rule { pattern: Pattern; action: Stmt[] | null }
interface Func { params: string[]; body: Stmt[] }
interface Program { rules: Rule[]; funcs: Map<string, Func>; mainGetline: boolean }

// ── Parser ─────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  /** Inside an unparenthesised print argument list, `>` is a redirect. */
  private noGt = false;
  private inFunc = false;
  private funcs = new Map<string, Func>();
  /** Does the program read main input with getline (so input must be ready for BEGIN)? */
  private mainGetline = false;
  constructor(private toks: Tok[]) {}

  private peek(o = 0): Tok { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private isOp(v: string, o = 0) { const t = this.peek(o); return t.t === 'op' && t.v === v; }
  private isName(v: string) { const t = this.peek(); return t.t === 'name' && t.v === v; }
  private eatOp(v: string) { if (this.isOp(v)) { this.pos++; return true; } return false; }
  private expectOp(v: string) { if (!this.eatOp(v)) throw new AwkError(`syntax error: expected '${v}' near ${this.describe()}`); }
  private skipNl() { while (this.peek().t === 'nl') this.pos++; }
  private skipTerms() { while (this.peek().t === 'nl' || this.isOp(';')) this.pos++; }
  private describe(): string {
    const t = this.peek();
    if (t.t === 'eof') return 'end of program';
    if (t.t === 'nl') return 'newline';
    return `'${(t as { v: unknown }).v}'`;
  }

  parseProgram(): Program {
    const rules: Rule[] = [];
    this.skipTerms();
    while (this.peek().t !== 'eof') {
      if (this.isName('function') || this.isName('func')) {
        this.parseFunction();
        this.skipTerms();
        continue;
      }
      let pattern: Pattern;
      if (this.isName('BEGIN')) { this.pos++; pattern = { k: 'BEGIN' }; }
      else if (this.isName('END')) { this.pos++; pattern = { k: 'END' }; }
      else if (this.isOp('{')) pattern = { k: 'all' };
      else {
        const from = this.parseExpr();
        if (this.eatOp(',')) {
          this.skipNl();
          pattern = { k: 'range', from, to: this.parseExpr(), active: false };
        } else pattern = { k: 'expr', e: from };
      }
      let action: Stmt[] | null = null;
      if (this.isOp('{')) action = this.parseBlock();
      else if (pattern.k === 'BEGIN' || pattern.k === 'END') throw new AwkError(`${pattern.k} needs an action`);
      rules.push({ pattern, action });
      this.skipTerms();
    }
    return { rules, funcs: this.funcs, mainGetline: this.mainGetline };
  }

  /** `function name(a, b,   locals) { … }` */
  private parseFunction() {
    this.pos++;
    const nt = this.next();
    if ((nt.t !== 'name' && nt.t !== 'ufunc') || KEYWORDS.has(nt.v)) {
      this.pos--;
      throw new AwkError(`syntax error: bad function name near ${this.describe()}`);
    }
    const name = nt.v;
    if (this.funcs.has(name)) throw new AwkError(`function ${name} defined twice`);
    this.expectOp('(');
    const params: string[] = [];
    this.skipNl();
    while (!this.isOp(')')) {
      const p = this.next();
      if (p.t !== 'name' || KEYWORDS.has(p.v)) { this.pos--; throw new AwkError(`syntax error: bad parameter near ${this.describe()}`); }
      if (p.v === name || params.includes(p.v)) throw new AwkError(`function ${name}: duplicate or invalid parameter ${p.v}`);
      params.push(p.v);
      this.skipNl();
      if (!this.eatOp(',')) break;
      this.skipNl();
    }
    this.expectOp(')');
    this.skipNl();
    const prev = this.inFunc;
    this.inFunc = true;
    const body = this.parseBlock();
    this.inFunc = prev;
    this.funcs.set(name, { params, body });
  }

  /** The subscript list after `name[`; the `[` is the current token. */
  private parseSubscripts(): Node[] {
    this.expectOp('[');
    const prev = this.noGt;
    this.noGt = false;
    this.skipNl();
    const subs = [this.parseExpr()];
    while (this.eatOp(',')) { this.skipNl(); subs.push(this.parseExpr()); }
    this.skipNl();
    this.noGt = prev;
    this.expectOp(']');
    return subs;
  }

  private expectArrayName(what: string): string {
    const t = this.next();
    if (t.t !== 'name' || KEYWORDS.has(t.v)) { this.pos--; throw new AwkError(`syntax error: ${what} needs an array name near ${this.describe()}`); }
    return t.v;
  }

  private parseBlock(): Stmt[] {
    this.expectOp('{');
    const body: Stmt[] = [];
    this.skipTerms();
    while (!this.isOp('}')) {
      if (this.peek().t === 'eof') throw new AwkError("syntax error: missing '}'");
      body.push(this.parseStmt());
      this.skipTerms();
    }
    this.pos++;
    return body;
  }

  /** End of a simple statement: `;`, newline, `}` or EOF. */
  private endSimple() {
    const t = this.peek();
    if (t.t === 'nl' || t.t === 'eof' || this.isOp('}')) return;
    if (this.eatOp(';')) return;
    throw new AwkError(`syntax error near ${this.describe()}`);
  }

  private parseStmt(): Stmt {
    if (this.isOp('{')) return { k: 'block', body: this.parseBlock() };
    if (this.isOp(';')) { this.pos++; return { k: 'block', body: [] }; }
    const t = this.peek();
    if (t.t === 'name') {
      switch (t.v) {
        case 'if': {
          this.pos++;
          this.expectOp('(');
          const c = this.parseExpr();
          this.expectOp(')');
          this.skipNl();
          const then = this.parseStmt();
          const save = this.pos;
          this.skipTerms();
          if (this.isName('else')) {
            this.pos++;
            this.skipNl();
            return { k: 'if', c, then, else: this.parseStmt() };
          }
          this.pos = save;
          return { k: 'if', c, then };
        }
        case 'while': {
          this.pos++;
          this.expectOp('(');
          const c = this.parseExpr();
          this.expectOp(')');
          this.skipNl();
          return { k: 'while', c, body: this.parseStmt() };
        }
        case 'for': {
          this.pos++;
          this.expectOp('(');
          const t0 = this.peek(), t1 = this.peek(1), t2 = this.peek(2);
          if (t0.t === 'name' && !KEYWORDS.has(t0.v) && t1.t === 'name' && t1.v === 'in'
            && t2.t === 'name' && !KEYWORDS.has(t2.v) && this.isOp(')', 3)) {
            this.pos += 4;
            this.skipNl();
            return { k: 'forin', v: t0.v, arr: t2.v, body: this.parseStmt() };
          }
          const init = this.isOp(';') ? undefined : this.parseExpr();
          this.expectOp(';');
          this.skipNl();
          const c = this.isOp(';') ? undefined : this.parseExpr();
          this.expectOp(';');
          this.skipNl();
          const step = this.isOp(')') ? undefined : this.parseExpr();
          this.expectOp(')');
          this.skipNl();
          return { k: 'for', init, c, step, body: this.parseStmt() };
        }
        case 'do': {
          this.pos++;
          this.skipNl();
          const body = this.parseStmt();
          this.skipTerms();
          if (!this.isName('while')) throw new AwkError(`syntax error: do needs a while near ${this.describe()}`);
          this.pos++;
          this.expectOp('(');
          const c = this.parseExpr();
          this.expectOp(')');
          this.endSimple();
          return { k: 'do', body, c };
        }
        case 'break': this.pos++; this.endSimple(); return { k: 'break' };
        case 'continue': this.pos++; this.endSimple(); return { k: 'continue' };
        case 'next': this.pos++; this.endSimple(); return { k: 'next' };
        case 'exit': {
          this.pos++;
          const tt = this.peek();
          const e = tt.t === 'nl' || tt.t === 'eof' || this.isOp(';') || this.isOp('}') ? undefined : this.parseExpr();
          this.endSimple();
          return { k: 'exit', e };
        }
        case 'print':
        case 'printf': {
          this.pos++;
          const args = this.parsePrintArgs();
          let redir: Redirect | undefined;
          if (this.isOp('>') || this.isOp('>>')) {
            const mode = (this.next() as { v: string }).v as '>' | '>>';
            const prev = this.noGt;
            this.noGt = true;
            redir = { mode, target: this.parseConcat() };
            this.noGt = prev;
          } else if (this.isOp('|')) {
            throw new AwkError('print | command is not supported');
          }
          this.endSimple();
          if (t.v === 'printf' && args.length === 0) throw new AwkError('printf: no format');
          return { k: t.v, args, redir } as Stmt;
        }
        case 'delete': {
          this.pos++;
          const name = this.expectArrayName('delete');
          const subs = this.isOp('[') ? this.parseSubscripts() : undefined;
          this.endSimple();
          return { k: 'delete', name, subs };
        }
        case 'return': {
          if (!this.inFunc) throw new AwkError('return outside a function');
          this.pos++;
          const tt = this.peek();
          const e = tt.t === 'nl' || tt.t === 'eof' || this.isOp(';') || this.isOp('}') ? undefined : this.parseExpr();
          this.endSimple();
          return { k: 'return', e };
        }
      }
    }
    const e = this.parseExpr();
    this.endSimple();
    return { k: 'expr', e };
  }

  private parsePrintArgs(): Node[] {
    const t = this.peek();
    if (t.t === 'nl' || t.t === 'eof' || this.isOp(';') || this.isOp('}') || this.isOp('>') || this.isOp('>>') || this.isOp('|')) return [];
    const prev = this.noGt;
    this.noGt = true;
    const args: Node[] = [this.parseExpr()];
    while (this.eatOp(',')) { this.skipNl(); args.push(this.parseExpr()); }
    this.noGt = prev;
    // `print (a, b)` → the parenthesised list is the argument list.
    if (args.length === 1 && args[0].k === 'list') return args[0].items;
    return args;
  }

  parseExpr(): Node { return this.parseAssign(); }

  private parseAssign(): Node {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(t.v)) {
      if (left.k !== 'var' && left.k !== 'field' && left.k !== 'index') throw new AwkError('syntax error: assignment to a non-variable');
      this.pos++;
      this.skipNl();
      return { k: 'assign', op: t.v, target: left, e: this.parseAssign() };
    }
    return left;
  }

  /** `c ? a : b`, right-associative: `a ? b : c ? d : e`. */
  private parseTernary(): Node {
    const c = this.parseOr();
    if (!this.eatOp('?')) return c;
    this.skipNl();
    const a = this.parseAssign();
    this.skipNl();
    this.expectOp(':');
    this.skipNl();
    const b = this.parseAssign();
    return { k: 'cond', c, a, b };
  }

  private parseOr(): Node {
    let l = this.parseAnd();
    while (this.eatOp('||')) { this.skipNl(); l = { k: 'or', l, r: this.parseAnd() }; }
    return l;
  }

  private parseAnd(): Node {
    let l = this.parseIn();
    while (this.eatOp('&&')) { this.skipNl(); l = { k: 'and', l, r: this.parseIn() }; }
    return l;
  }

  /** `k in a`, `(i, j) in a`. */
  private parseIn(): Node {
    let l = this.parseMatch();
    while (this.isName('in')) {
      this.pos++;
      const name = this.expectArrayName('in');
      l = { k: 'in', subs: l.k === 'list' ? l.items : [l], name };
    }
    return l;
  }

  private parseMatch(): Node {
    let l = this.parseCompare();
    while (this.isOp('~') || this.isOp('!~')) {
      const neg = (this.next() as { v: string }).v === '!~';
      l = { k: 'match', neg, l, r: this.parseCompare() };
    }
    return l;
  }

  private parseCompare(): Node {
    const l = this.parseConcat();
    if (this.isOp('|') && this.peek(1).t === 'name' && (this.peek(1) as { v: string }).v === 'getline') {
      throw new AwkError('"cmd" | getline is not supported');
    }
    const t = this.peek();
    if (t.t === 'op' && (['<', '<=', '==', '!=', '>='].includes(t.v) || (t.v === '>' && !this.noGt))) {
      this.pos++;
      return { k: 'cmp', op: t.v, l, r: this.parseConcat() };
    }
    return l;
  }

  private startsConcatOperand(): boolean {
    const t = this.peek();
    if (t.t === 'num' || t.t === 'str' || t.t === 'func' || t.t === 'ufunc') return true;
    if (t.t === 'name') return !KEYWORDS.has(t.v);
    if (t.t === 'op') return t.v === '$' || t.v === '(' || t.v === '!' || t.v === '++' || t.v === '--' || t.v === '-';
    return false;
  }

  private parseConcat(): Node {
    let l = this.parseAdditive();
    while (this.startsConcatOperand() && !this.isOp('-') && !this.isOp('!')) {
      l = { k: 'concat', l, r: this.parseAdditive() };
    }
    return l;
  }

  private parseAdditive(): Node {
    let l = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.parseMul() };
    }
    return l;
  }

  private parseMul(): Node {
    let l = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.next() as { v: string }).v;
      l = { k: 'bin', op, l, r: this.parseUnary() };
    }
    return l;
  }

  private parseUnary(): Node {
    if (this.eatOp('!')) return { k: 'not', e: this.parseUnary() };
    if (this.eatOp('-')) return { k: 'neg', e: this.parseUnary() };
    if (this.eatOp('+')) return { k: 'pos', e: this.parseUnary() };
    return this.parsePow();
  }

  private parsePow(): Node {
    const base = this.parsePostfix();
    if (this.eatOp('^')) return { k: 'bin', op: '^', l: base, r: this.parseUnary() };
    return base;
  }

  private parsePostfix(): Node {
    const p = this.parsePrimary();
    if ((p.k === 'var' || p.k === 'field' || p.k === 'index') && (this.isOp('++') || this.isOp('--'))) {
      const op = (this.next() as { v: string }).v as '++' | '--';
      return { k: 'incdec', op, pre: false, target: p };
    }
    return p;
  }

  private parsePrimary(): Node {
    const t = this.next();
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'regex': return { k: 'regex', v: t.v };
      case 'func': {
        if (t.v === 'system') throw new AwkError('system() is not supported');
        if (!this.isOp('(')) return { k: 'call', name: t.v, args: [] }; // bare `length`
        this.pos++;
        const args: Node[] = [];
        const prev = this.noGt;
        this.noGt = false;
        this.skipNl();
        if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.eatOp(',')) { this.skipNl(); args.push(this.parseExpr()); }
        }
        this.noGt = prev;
        this.expectOp(')');
        if (t.v === 'split' && (args.length < 2 || args.length > 3 || args[1].k !== 'var')) {
          throw new AwkError('split(s, array [, sep]) needs an array name as its second argument');
        }
        return { k: 'call', name: t.v, args };
      }
      case 'ufunc': {
        this.expectOp('(');
        const args: Node[] = [];
        const prev = this.noGt;
        this.noGt = false;
        this.skipNl();
        if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.eatOp(',')) { this.skipNl(); args.push(this.parseExpr()); }
        }
        this.skipNl();
        this.noGt = prev;
        this.expectOp(')');
        return { k: 'ucall', name: t.v, args };
      }
      case 'name': {
        if (t.v === 'getline') return this.parseGetline();
        if (KEYWORDS.has(t.v)) throw new AwkError(`syntax error at '${t.v}'`);
        if (this.isOp('[')) return { k: 'index', name: t.v, subs: this.parseSubscripts() };
        return { k: 'var', name: t.v };
      }
      case 'op': {
        if (t.v === '$') {
          // `$` binds tighter than everything but grouping and ++/--.
          const e = this.isOp('++') || this.isOp('--') ? this.parseIncPrefix() : this.parsePrimary();
          return { k: 'field', e };
        }
        if (t.v === '++' || t.v === '--') {
          const target = this.parsePrimary();
          if (target.k !== 'var' && target.k !== 'field' && target.k !== 'index') throw new AwkError(`syntax error: ${t.v} needs a variable`);
          return { k: 'incdec', op: t.v, pre: true, target };
        }
        if (t.v === '-') return { k: 'neg', e: this.parseUnary() };
        if (t.v === '!') return { k: 'not', e: this.parseUnary() };
        if (t.v === '(') {
          const prev = this.noGt;
          this.noGt = false;
          this.skipNl();
          const items = [this.parseExpr()];
          while (this.eatOp(',')) { this.skipNl(); items.push(this.parseExpr()); }
          this.skipNl();
          this.noGt = prev;
          this.expectOp(')');
          if (items.length > 1) return { k: 'list', items };
          return { k: 'group', e: items[0] };
        }
        break;
      }
    }
    this.pos--;
    throw new AwkError(`syntax error near ${this.describe()}`);
  }

  /** After `getline`: optional lvalue, optional `< file`. */
  private parseGetline(): Node {
    let target: Node | undefined;
    const t = this.peek();
    if ((t.t === 'name' && !KEYWORDS.has(t.v)) || this.isOp('$')) target = this.parsePrimary();
    let file: Node | undefined;
    if (this.eatOp('<')) file = this.parsePrimary();
    else this.mainGetline = true;
    return { k: 'getline', target, file };
  }

  private parseIncPrefix(): Node {
    const op = (this.next() as { v: string }).v as '++' | '--';
    const target = this.parsePrimary();
    if (target.k !== 'var' && target.k !== 'field' && target.k !== 'index') throw new AwkError(`syntax error: ${op} needs a variable`);
    return { k: 'incdec', op, pre: true, target };
  }
}

// ── Values ─────────────────────────────────────────────────────────────────

const NUMERIC_RE = /^[ \t\n]*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)[ \t\n]*$/;

function toNum(v: V): number {
  if (typeof v === 'number') return v;
  const m = /^[ \t\n]*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+([eE][-+]?\d+)?)/.exec(v);
  return m ? Number(m[0]) : 0;
}

/** %.6g, the default OFMT/CONVFMT; integers print as integers. */
function fmtNum(n: number, prec = 6): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : n < 0 ? '-inf' : 'nan';
  return fmtG(n, prec, false);
}

function fmtG(n: number, prec: number, alt: boolean): string {
  const p = prec === 0 ? 1 : prec;
  if (n === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  let s: string;
  if (exp < -4 || exp >= p) {
    s = n.toExponential(p - 1);
    let [mant, e] = s.split('e');
    if (!alt && mant.includes('.')) mant = mant.replace(/\.?0+$/, '');
    const sign = e[0] === '-' ? '-' : '+';
    const digits = e.replace(/^[-+]/, '').padStart(2, '0');
    return `${mant}e${sign}${digits}`;
  }
  s = n.toFixed(Math.max(0, p - 1 - exp));
  if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

function toStr(v: V): string { return typeof v === 'number' ? fmtNum(v) : v; }

function fmtExp(n: number, prec: number, upper: boolean): string {
  let s = n.toExponential(prec);
  s = s.replace(/e([-+])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}

/** printf / sprintf formatting. */
function format(fmt: string, args: V[]): string {
  let out = '';
  let ai = 0;
  const nextArg = (): V => (ai < args.length ? args[ai++] : '');
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    if (fmt[i + 1] === '%') { out += '%'; i++; continue; }
    const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([diouxXeEfFgGcs])/.exec(fmt.slice(i));
    if (!m) { out += c; continue; }
    i += m[0].length - 1;
    const flags = m[1];
    let width = m[2] === '*' ? toNum(nextArg()) : m[2] ? parseInt(m[2], 10) : 0;
    let left = flags.includes('-');
    if (width < 0) { left = true; width = -width; }
    const precRaw = m[3] === '*' ? String(Math.trunc(toNum(nextArg()))) : m[3];
    const prec = precRaw === undefined ? undefined : precRaw === '' ? 0 : parseInt(precRaw, 10);
    const conv = m[4];
    const arg = nextArg();
    let body: string;
    let numeric = true;
    const signed = (n: number, s: string) => (n < 0 ? s : flags.includes('+') ? '+' + s : flags.includes(' ') ? ' ' + s : s);
    switch (conv) {
      case 'd': case 'i': {
        const n = Math.trunc(toNum(arg));
        let s = Math.abs(n).toString();
        if (prec !== undefined) s = s.padStart(prec, '0');
        body = signed(n, n < 0 ? '-' + s : s);
        break;
      }
      case 'o': case 'u': case 'x': case 'X': {
        const n = Math.trunc(toNum(arg));
        const base = conv === 'o' ? 8 : conv === 'u' ? 10 : 16;
        let s = (n < 0 ? n >>> 0 : n).toString(base);
        if (conv === 'X') s = s.toUpperCase();
        if (prec !== undefined) s = s.padStart(prec, '0');
        if (flags.includes('#') && n !== 0) s = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + s;
        body = s;
        break;
      }
      case 'e': case 'E': {
        const n = toNum(arg);
        body = signed(n, fmtExp(n, prec ?? 6, conv === 'E'));
        break;
      }
      case 'f': case 'F': {
        const n = toNum(arg);
        body = signed(n, n.toFixed(prec ?? 6));
        break;
      }
      case 'g': case 'G': {
        const n = toNum(arg);
        let s = fmtG(n, prec ?? 6, flags.includes('#'));
        if (conv === 'G') s = s.toUpperCase();
        body = signed(n, s);
        break;
      }
      case 'c': {
        numeric = false;
        body = typeof arg === 'number' ? String.fromCodePoint(Math.trunc(arg)) : arg.slice(0, 1);
        break;
      }
      default: { // s
        numeric = false;
        const s = toStr(arg);
        body = prec !== undefined ? s.slice(0, prec) : s;
      }
    }
    if (body.length < width) {
      if (left) body = body.padEnd(width);
      else if (numeric && flags.includes('0') && prec === undefined) {
        const sign = /^[-+ ]/.test(body) ? body[0] : '';
        body = sign + body.slice(sign.length).padStart(width - sign.length, '0');
      } else body = body.padStart(width);
    }
    out += body;
  }
  return out;
}

// ── Interpreter ────────────────────────────────────────────────────────────

class NextSignal {}
class ExitSignal { constructor(public code: number) {} }
class BreakSignal {}
class ContinueSignal {}
class ReturnSignal { constructor(public value: V) {} }

type AwkArray = Map<string, V | undefined>;

/**
 * An untyped variable passed to a function: it stays a scalar local unless the
 * function uses it as an array, in which case the array is created in the
 * caller's slot too (so it is shared by reference, as in gawk).
 */
class PendingArray {
  constructor(private scope: Map<string, Slot>, private name: string) {}
  materialize(): AwkArray {
    const s = this.scope.get(this.name);
    if (s instanceof Map) return s;
    if (s instanceof PendingArray) { const a = s.materialize(); this.scope.set(this.name, a); return a; }
    if (s === undefined) { const a: AwkArray = new Map(); this.scope.set(this.name, a); return a; }
    throw new AwkError(`can't use scalar ${this.name} as an array`);
  }
}

/** A variable slot: scalar, array, untyped-passed-in, or uninitialised. */
type Slot = V | AwkArray | PendingArray | undefined;

interface LValue { get(): V; set(v: V): void }

/** The main input as a record stream, shared by the rule loop and getline. */
class MainInput {
  private idx = 0;
  private lines: string[] | null = null;
  private pos = 0;
  constructor(private inputs: { name: string; text: string }[], private rt: Runtime) {}
  next(): string | null {
    for (;;) {
      if (!this.lines) {
        if (this.idx >= this.inputs.length) return null;
        const inp = this.inputs[this.idx++];
        this.rt.vars.set('FILENAME', inp.name);
        this.rt.vars.set('FNR', 0);
        this.lines = inp.text === '' ? [] : inp.text.replace(/\n$/, '').split('\n');
        this.pos = 0;
      }
      if (this.pos < this.lines.length) {
        this.rt.vars.set('NR', toNum(this.rt.getVar('NR')) + 1);
        this.rt.vars.set('FNR', toNum(this.rt.getVar('FNR')) + 1);
        return this.lines[this.pos++];
      }
      this.lines = null;
    }
  }
}

/** Split on a global regex, ignoring capture groups and empty matches. */
function reSplit(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push(s.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

class Runtime {
  /** Globals. */
  vars = new Map<string, Slot>();
  /** Locals of the running user function, if any. */
  private frame: Map<string, Slot> | null = null;
  funcs = new Map<string, Func>();
  mainInput: MainInput | null = null;
  record = '';
  fields: string[] = [];
  private regexCache = new Map<string, RegExp>();
  private opened = new Set<string>();
  private readers = new Map<string, { lines: string[]; pos: number }>();

  constructor(
    private write: (s: string) => void,
    private writeFile: (path: string, s: string, append: boolean) => void,
    private readFile: (path: string) => string | null,
  ) {}

  regex(src: string, flags = ''): RegExp {
    const key = flags + '\0' + src;
    let re = this.regexCache.get(key);
    if (!re) {
      try { re = new RegExp(posixToJs(src, true), flags); } catch { throw new AwkError(`invalid regex: ${src}`); }
      this.regexCache.set(key, re);
    }
    return re;
  }

  /** Number → string with CONVFMT (integers stay integers). */
  str(v: V): string {
    if (typeof v !== 'number') return v;
    if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
    const conv = this.vars.get('CONVFMT');
    return conv === undefined || conv === '%.6g' || typeof conv !== 'string' ? fmtNum(v) : format(conv, [v]);
  }

  setRecord(line: string) {
    this.record = line;
    this.fields = this.splitWith(line, (this.vars.get('FS') ?? ' ') as V);
  }

  /** awk field splitting: " " = runs of blanks (trimmed), one char = literal, else a regex. */
  private splitWith(r: string, sep: V | RegExp): string[] {
    if (sep instanceof RegExp) return r === '' ? [] : reSplit(r, sep);
    const fs = this.str(sep);
    if (fs === ' ') return r.split(/[ \t\n]+/).filter((f) => f !== '');
    if (r === '') return [];
    if (fs === '') return [...r];
    if (fs.length === 1 && fs !== '\\') return r.split(fs);
    return reSplit(r, this.regex(fs, 'g'));
  }

  private scopeOf(name: string): Map<string, Slot> {
    const f = this.frame;
    return f && f.has(name) ? f : this.vars;
  }

  getVar(name: string): V {
    if (name === 'NF') return this.fields.length;
    const s = this.scopeOf(name).get(name);
    if (s instanceof Map) throw new AwkError(`attempt to use array ${name} in a scalar context`);
    if (s === undefined || s instanceof PendingArray) return '';
    return s;
  }

  private setVar(name: string, v: V) {
    if (name === 'NF') {
      const n = Math.trunc(toNum(v));
      this.fields.length = Math.max(0, n);
      for (let k = 0; k < this.fields.length; k++) this.fields[k] ??= '';
      this.record = this.fields.join(this.str(this.getVar('OFS')));
      return;
    }
    const scope = this.scopeOf(name);
    if (scope.get(name) instanceof Map) throw new AwkError(`attempt to use array ${name} in a scalar context`);
    scope.set(name, v);
  }

  getArray(name: string): AwkArray {
    const scope = this.scopeOf(name);
    const s = scope.get(name);
    if (s instanceof Map) return s;
    if (s instanceof PendingArray) { const a = s.materialize(); scope.set(name, a); return a; }
    if (s === undefined && name !== 'NF') { const a: AwkArray = new Map(); scope.set(name, a); return a; }
    throw new AwkError(`can't use scalar ${name} as an array`);
  }

  private key(subs: Node[]): string {
    if (subs.length === 1) return this.str(this.eval(subs[0]));
    const sep = this.str(this.getVar('SUBSEP'));
    return subs.map((n) => this.str(this.eval(n))).join(sep);
  }

  getField(i: number): string {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) return this.record;
    return this.fields[i - 1] ?? '';
  }

  setField(i: number, v: string) {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) { this.setRecord(v); return; }
    while (this.fields.length < i) this.fields.push('');
    this.fields[i - 1] = v;
    this.record = this.fields.join(this.str(this.getVar('OFS')));
  }

  /** Resolve an assignable expression once (subscripts / field numbers evaluated a single time). */
  private lvalue(n: Node): LValue {
    switch (n.k) {
      case 'var': return { get: () => this.getVar(n.name), set: (v) => this.setVar(n.name, v) };
      case 'field': {
        const i = Math.trunc(toNum(this.eval(n.e)));
        return { get: () => this.getField(i), set: (v) => this.setField(i, this.str(v)) };
      }
      case 'index': {
        const arr = this.getArray(n.name);
        const key = this.key(n.subs);
        return {
          get: () => { const v = arr.get(key); if (v === undefined) arr.set(key, undefined); return v ?? ''; },
          set: (v) => { arr.set(key, v); },
        };
      }
      case 'group': return this.lvalue(n.e);
    }
    throw new AwkError('syntax error: assignment to a non-variable');
  }

  /** Evaluate a comparison operand: its value and whether it compares numerically. */
  private operand(n: Node): [V, boolean] {
    if (n.k === 'index') {
      const arr = this.getArray(n.name);
      const key = this.key(n.subs);
      const v = arr.get(key);
      if (v === undefined) { arr.set(key, undefined); return ['', true]; }
      return [v, typeof v === 'number' || NUMERIC_RE.test(v)];
    }
    const v = this.eval(n);
    if (typeof v === 'number') return [v, true];
    if (n.k === 'var' && n.name !== 'NF') {
      const s = this.scopeOf(n.name).get(n.name);
      if (s === undefined || s instanceof PendingArray) return [v, true];
    }
    if (n.k === 'str' || n.k === 'concat' || n.k === 'call') return [v, false];
    return [v, NUMERIC_RE.test(v)];
  }

  truthy(n: Node, v: V): boolean {
    if (typeof v === 'number') return v !== 0;
    if (n.k !== 'str' && n.k !== 'concat' && n.k !== 'call' && NUMERIC_RE.test(v)) return toNum(v) !== 0;
    return v !== '';
  }

  test(n: Node): boolean {
    if (n.k === 'regex') return this.regex(n.v).test(this.record);
    return this.truthy(n, this.eval(n));
  }

  private arith(op: string, a: number, b: number): number {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': if (b === 0) throw new AwkError('division by zero'); return a / b;
      case '%': if (b === 0) throw new AwkError('division by zero in %'); return a % b;
      case '^': return Math.pow(a, b);
    }
    throw new AwkError(`unknown operator ${op}`);
  }

  eval(n: Node): V {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'regex': return this.regex(n.v).test(this.record) ? 1 : 0;
      case 'var': return this.getVar(n.name);
      case 'index': return this.lvalue(n).get();
      case 'in': {
        const arr = this.getArray(n.name);
        return arr.has(this.key(n.subs)) ? 1 : 0;
      }
      case 'field': return this.getField(Math.trunc(toNum(this.eval(n.e))));
      case 'group': return this.eval(n.e);
      case 'list': throw new AwkError('syntax error: unexpected list');
      case 'assign': {
        const lv = this.lvalue(n.target);
        let v: V;
        if (n.op === '=') {
          v = this.eval(n.e);
        } else {
          const cur = toNum(lv.get());
          v = this.arith(n.op[0], cur, toNum(this.eval(n.e)));
        }
        lv.set(v);
        return v;
      }
      case 'cond': return this.test(n.c) ? this.eval(n.a) : this.eval(n.b);
      case 'or': return this.test(n.l) || this.test(n.r) ? 1 : 0;
      case 'and': return this.test(n.l) && this.test(n.r) ? 1 : 0;
      case 'not': return this.test(n.e) ? 0 : 1;
      case 'neg': return -toNum(this.eval(n.e));
      case 'pos': return toNum(this.eval(n.e));
      case 'bin': return this.arith(n.op, toNum(this.eval(n.l)), toNum(this.eval(n.r)));
      case 'concat': return this.str(this.eval(n.l)) + this.str(this.eval(n.r));
      case 'cmp': {
        const [l, ln] = this.operand(n.l);
        const [r, rn] = this.operand(n.r);
        let c: number;
        if (ln && rn) {
          const a = toNum(l), b = toNum(r);
          c = a < b ? -1 : a > b ? 1 : 0;
        } else {
          const a = this.str(l), b = this.str(r);
          c = a < b ? -1 : a > b ? 1 : 0;
        }
        switch (n.op) {
          case '<': return c < 0 ? 1 : 0;
          case '<=': return c <= 0 ? 1 : 0;
          case '>': return c > 0 ? 1 : 0;
          case '>=': return c >= 0 ? 1 : 0;
          case '==': return c === 0 ? 1 : 0;
          default: return c !== 0 ? 1 : 0;
        }
      }
      case 'match': {
        const s = this.str(this.eval(n.l));
        const re = n.r.k === 'regex' ? this.regex(n.r.v) : this.regex(this.str(this.eval(n.r)));
        return re.test(s) !== n.neg ? 1 : 0;
      }
      case 'incdec': {
        const lv = this.lvalue(n.target);
        const old = toNum(lv.get());
        const nv = n.op === '++' ? old + 1 : old - 1;
        lv.set(nv);
        return n.pre ? nv : old;
      }
      case 'call': return this.call(n.name, n.args);
      case 'ucall': return this.callUser(n.name, n.args);
      case 'getline': return this.getline(n.target, n.file);
    }
  }

  private getline(target: Node | undefined, file: Node | undefined): V {
    let line: string | null;
    if (file) {
      const path = this.str(this.eval(file));
      let r = this.readers.get(path);
      if (!r) {
        const text = this.readFile(path);
        if (text === null) return -1;
        r = { lines: splitLines(text), pos: 0 };
        this.readers.set(path, r);
      }
      line = r.pos < r.lines.length ? r.lines[r.pos++] : null;
    } else {
      line = this.mainInput ? this.mainInput.next() : null;
    }
    if (line === null) return 0;
    if (target) this.lvalue(target).set(line);
    else this.setRecord(line);
    return 1;
  }

  private callUser(name: string, argNodes: Node[]): V {
    const fn = this.funcs.get(name);
    if (!fn) throw new AwkError(`function ${name} is not defined`);
    if (argNodes.length > fn.params.length) {
      throw new AwkError(`function ${name} called with ${argNodes.length} arguments, accepts only ${fn.params.length}`);
    }
    // Arguments are evaluated in the caller's scope before the new frame exists.
    const frame = new Map<string, Slot>();
    fn.params.forEach((p, i) => {
      const a = argNodes[i];
      if (!a) { frame.set(p, undefined); return; }
      if (a.k === 'var' && a.name !== 'NF') {
        const scope = this.scopeOf(a.name);
        const s = scope.get(a.name);
        if (s instanceof Map || s instanceof PendingArray) { frame.set(p, s); return; }
        if (s === undefined) { frame.set(p, new PendingArray(scope, a.name)); return; }
      }
      frame.set(p, this.eval(a));
    });
    const saved = this.frame;
    this.frame = frame;
    try {
      this.exec(fn.body);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    } finally {
      this.frame = saved;
    }
    return '';
  }

  /** The slot a bare-name argument refers to, without forcing a type. */
  private slotOf(n: Node): Slot {
    return n.k === 'var' ? this.scopeOf(n.name).get(n.name) : undefined;
  }

  private call(name: string, args: Node[]): V {
    const s = (k: number) => this.str(this.eval(args[k]));
    const num = (k: number) => toNum(this.eval(args[k]));
    switch (name) {
      case 'length': {
        if (args.length === 0) return [...this.record].length;
        const slot = this.slotOf(args[0]);
        if (slot instanceof Map) return slot.size;
        if (slot instanceof PendingArray) return 0;
        return [...s(0)].length;
      }
      case 'split': {
        const str = s(0);
        const arr = this.getArray((args[1] as { name: string }).name);
        const sep: V | RegExp = args.length < 3
          ? ((this.vars.get('FS') ?? ' ') as V)
          : args[2].k === 'regex' ? this.regex(args[2].v, 'g') : this.eval(args[2]);
        const parts = this.splitWith(str, sep);
        arr.clear();
        parts.forEach((p, i) => arr.set(String(i + 1), p));
        return parts.length;
      }
      case 'close': {
        const path = s(0);
        const hadReader = this.readers.delete(path);
        const hadWriter = this.opened.delete(path);
        return hadReader || hadWriter ? 0 : -1;
      }
      case 'substr': {
        const str = s(0);
        const len = str.length;
        let m = Math.round(num(1));
        let end = args.length > 2 ? m + Math.round(num(2)) : len + 1;
        if (m < 1) m = 1;
        if (end > len + 1) end = len + 1;
        return end <= m ? '' : str.slice(m - 1, end - 1);
      }
      case 'index': return s(0).indexOf(s(1)) + 1;
      case 'toupper': return s(0).toUpperCase();
      case 'tolower': return s(0).toLowerCase();
      case 'sprintf': return args.length ? format(s(0), args.slice(1).map((a) => this.eval(a))) : '';
      case 'int': return Math.trunc(num(0));
      case 'sqrt': return Math.sqrt(num(0));
      case 'exp': return Math.exp(num(0));
      case 'log': return Math.log(num(0));
      case 'sin': return Math.sin(num(0));
      case 'cos': return Math.cos(num(0));
      case 'atan2': return Math.atan2(num(0), num(1));
      case 'rand': return Math.random();
      case 'srand': return 0;
      case 'match': {
        const str = s(0);
        const re = args[1].k === 'regex' ? this.regex(args[1].v) : this.regex(s(1));
        const m = re.exec(str);
        const start = m ? m.index + 1 : 0;
        this.vars.set('RSTART', start);
        this.vars.set('RLENGTH', m ? m[0].length : -1);
        return start;
      }
      case 'sub':
      case 'gsub': {
        const re = args[0].k === 'regex' ? this.regex(args[0].v, 'g') : this.regex(s(0), 'g');
        const repl = s(1);
        const lv = this.lvalue(args[2] ?? { k: 'field', e: { k: 'num', v: 0 } });
        const str = this.str(lv.get());
        let count = 0;
        const out = str.replace(re, (m) => {
          if (name === 'sub' && count > 0) return m;
          count++;
          let r = '';
          for (let k = 0; k < repl.length; k++) {
            if (repl[k] === '\\' && (repl[k + 1] === '&' || repl[k + 1] === '\\')) { r += repl[++k]; continue; }
            r += repl[k] === '&' ? m : repl[k];
          }
          return r;
        });
        if (count > 0) lv.set(out);
        return count;
      }
    }
    throw new AwkError(`${name}() is not supported`);
  }

  exec(stmts: Stmt[]) {
    for (const st of stmts) this.execOne(st);
  }

  private emit(text: string, redir?: Redirect) {
    if (!redir) { this.write(text); return; }
    const path = this.str(this.eval(redir.target));
    const append = redir.mode === '>>' || this.opened.has(path);
    this.opened.add(path);
    this.writeFile(path, text, append);
  }

  private execOne(st: Stmt) {
    switch (st.k) {
      case 'print': {
        const ofs = this.str(this.getVar('OFS'));
        const ors = this.str(this.getVar('ORS'));
        const text = st.args.length === 0 ? this.record : st.args.map((a) => this.outStr(this.eval(a))).join(ofs);
        this.emit(text + ors, st.redir);
        return;
      }
      case 'printf': {
        const vals = st.args.map((a) => this.eval(a));
        this.emit(format(this.str(vals[0]), vals.slice(1)), st.redir);
        return;
      }
      case 'expr': this.eval(st.e); return;
      case 'if':
        if (this.test(st.c)) this.execOne(st.then);
        else if (st.else) this.execOne(st.else);
        return;
      case 'while':
        while (this.test(st.c)) {
          try { this.execOne(st.body); } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      case 'do':
        do {
          try { this.execOne(st.body); } catch (e) {
            if (e instanceof BreakSignal) break;
            if (!(e instanceof ContinueSignal)) throw e;
          }
        } while (this.test(st.c));
        return;
      case 'for':
        if (st.init) this.eval(st.init);
        while (!st.c || this.test(st.c)) {
          try { this.execOne(st.body); } catch (e) {
            if (e instanceof BreakSignal) break;
            if (!(e instanceof ContinueSignal)) throw e;
          }
          if (st.step) this.eval(st.step);
        }
        return;
      case 'forin': {
        const arr = this.getArray(st.arr);
        // Snapshot the keys (insertion order); skip ones deleted mid-loop.
        for (const k of [...arr.keys()]) {
          if (!arr.has(k)) continue;
          this.setVar(st.v, k);
          try { this.execOne(st.body); } catch (e) {
            if (e instanceof BreakSignal) break;
            if (!(e instanceof ContinueSignal)) throw e;
          }
        }
        return;
      }
      case 'delete': {
        const arr = this.getArray(st.name);
        if (st.subs) arr.delete(this.key(st.subs));
        else arr.clear();
        return;
      }
      case 'return': throw new ReturnSignal(st.e ? this.eval(st.e) : '');
      case 'block': this.exec(st.body); return;
      case 'next': throw new NextSignal();
      case 'break': throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
      case 'exit': throw new ExitSignal(st.e ? Math.trunc(toNum(this.eval(st.e))) : 0);
    }
  }

  private outStr(v: V): string {
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
      const ofmt = this.str(this.getVar('OFMT'));
      return ofmt === '%.6g' ? fmtNum(v) : format(ofmt, [v]);
    }
    return v;
  }
}

/** Decode backslash escapes in -F / -v values, as awk does. */
function cliValue(s: string): string { return unescapeString(s); }

const command: Command = async (ctx) => {
  let fs: string | undefined;
  let program = '';
  let haveProgram = false;
  const assigns: [string, string][] = [];
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (!haveProgram && arg === '-F' && i + 1 < ctx.args.length) {
      fs = ctx.args[++i];
    } else if (!haveProgram && arg.startsWith('-F') && arg.length > 2) {
      fs = arg.slice(2);
    } else if (!haveProgram && arg === '-v' && i + 1 < ctx.args.length) {
      const a = ctx.args[++i];
      const eq = a.indexOf('=');
      if (eq <= 0) { ctx.stderr.write(`awk: invalid -v argument: ${a}\n`); return 2; }
      assigns.push([a.slice(0, eq), cliValue(a.slice(eq + 1))]);
    } else if (!haveProgram && arg.startsWith('-v') && arg.length > 2 && arg.includes('=')) {
      const a = arg.slice(2);
      const eq = a.indexOf('=');
      assigns.push([a.slice(0, eq), cliValue(a.slice(eq + 1))]);
    } else if (!haveProgram && arg === '--') {
      continue;
    } else if (!haveProgram) {
      program = arg;
      haveProgram = true;
    } else {
      files.push(arg);
    }
  }

  if (!haveProgram) {
    ctx.stderr.write('awk: missing program\n');
    return 1;
  }

  let prog: Program;
  try {
    prog = new Parser(tokenize(program)).parseProgram();
  } catch (e) {
    if (e instanceof AwkError) { ctx.stderr.write(`awk: ${e.message}\n`); return 2; }
    throw e;
  }
  const { rules } = prog;

  const rt = new Runtime(
    (s) => ctx.stdout.write(s),
    (p, s, append) => {
      const path = resolve(ctx.cwd, p);
      const prev = append && ctx.vfs.exists(path) ? ctx.vfs.readFileString(path) : '';
      ctx.vfs.writeFile(path, prev + s);
    },
    (p) => {
      try { return ctx.vfs.readFileString(resolve(ctx.cwd, p)); } catch { return null; }
    },
  );
  rt.funcs = prog.funcs;
  rt.vars.set('FS', fs === undefined ? ' ' : fs === 't' ? '\t' : cliValue(fs));
  rt.vars.set('OFS', ' ');
  rt.vars.set('ORS', '\n');
  rt.vars.set('OFMT', '%.6g');
  rt.vars.set('CONVFMT', '%.6g');
  rt.vars.set('SUBSEP', '\x1c');
  rt.vars.set('NR', 0);
  rt.vars.set('FNR', 0);
  rt.vars.set('RSTART', 0);
  rt.vars.set('RLENGTH', -1);
  for (const [k, v] of assigns) rt.vars.set(k, v);

  /** Read the input files (or stdin); returns an exit code on failure. */
  const loadInputs = async (): Promise<{ name: string; text: string }[] | number> => {
    const inputs: { name: string; text: string }[] = [];
    if (files.length === 0) {
      if (!ctx.stdin) { ctx.stderr.write('awk: missing file operand\n'); return 1; }
      inputs.push({ name: '', text: await ctx.stdin.readAll() });
      return inputs;
    }
    for (const file of files) {
      const path = resolve(ctx.cwd, file);
      try {
        ctx.vfs.stat(path);
        if (isBinaryMime(getMimeType(path))) {
          ctx.stderr.write(`awk: ${file}: binary file, skipping\n`);
          continue;
        }
        inputs.push({ name: file, text: ctx.vfs.readFileString(path) });
      } catch (e) {
        if (e instanceof VFSError) {
          ctx.stderr.write(`awk: ${file}: ${e.message}\n`);
          return 2;
        }
        throw e;
      }
    }
    return inputs;
  };

  let exitCode = 0;
  let exiting = false;

  const runRules = (which: 'BEGIN' | 'END') => {
    for (const rule of rules) {
      if (rule.pattern.k !== which || !rule.action) continue;
      rt.exec(rule.action);
    }
  };

  const hasMain = rules.some((r) => r.pattern.k !== 'BEGIN' && r.pattern.k !== 'END');
  const hasEnd = rules.some((r) => r.pattern.k === 'END');

  try {
    // getline in BEGIN reads the main input, so it has to be ready first.
    if (prog.mainGetline) {
      const inputs = await loadInputs();
      if (typeof inputs === 'number') return inputs;
      rt.mainInput = new MainInput(inputs, rt);
    }

    try {
      runRules('BEGIN');
    } catch (e) {
      if (e instanceof ExitSignal) { exitCode = e.code; exiting = true; }
      else if (!(e instanceof NextSignal)) throw e;
    }

    if (!exiting && (hasMain || hasEnd)) {
      if (!rt.mainInput) {
        const inputs = await loadInputs();
        if (typeof inputs === 'number') return inputs;
        rt.mainInput = new MainInput(inputs, rt);
      }
      const input = rt.mainInput;
      for (let line = input.next(); line !== null; line = input.next()) {
        rt.setRecord(line);
        try {
          for (const rule of rules) {
            const p = rule.pattern;
            let hit: boolean;
            if (p.k === 'BEGIN' || p.k === 'END') continue;
            if (p.k === 'all') hit = true;
            else if (p.k === 'expr') hit = rt.test(p.e);
            else {
              if (p.active) {
                hit = true;
                if (rt.test(p.to)) p.active = false;
              } else if (rt.test(p.from)) {
                hit = true;
                p.active = !rt.test(p.to);
              } else hit = false;
            }
            if (!hit) continue;
            if (rule.action) rt.exec(rule.action);
            else ctx.stdout.write(rt.record + toStr(rt.getVar('ORS')));
          }
        } catch (e) {
          if (e instanceof NextSignal) continue;
          if (e instanceof ExitSignal) { exitCode = e.code; break; }
          throw e;
        }
      }
    }

    try {
      runRules('END');
    } catch (e) {
      if (e instanceof ExitSignal) exitCode = e.code;
      else throw e;
    }
  } catch (e) {
    if (e instanceof AwkError) { ctx.stderr.write(`awk: ${e.message}\n`); return 2; }
    if (e instanceof BreakSignal || e instanceof ContinueSignal) { ctx.stderr.write('awk: break/continue outside a loop\n'); return 2; }
    if (e instanceof NextSignal) { ctx.stderr.write('awk: next used in BEGIN or END\n'); return 2; }
    if (e instanceof RangeError) { ctx.stderr.write('awk: function call nesting too deep\n'); return 2; }
    throw e;
  }

  return exitCode;
};

export default command;
