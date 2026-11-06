import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';
import { posixToJs } from './sed.js';

/*
 * A small awk: a tokenizer, a recursive-descent parser for awk's expression
 * grammar (assignment, ?:, || && ! ~ comparisons, concatenation, arithmetic,
 * ^, ++/--, $field) and the common statements (print/printf with > / >>,
 * if/else, while, for(;;), break/continue/next/exit, blocks), plus BEGIN/END,
 * /regex/, expression and range patterns, and the usual string builtins.
 *
 * Not supported (reported as an error rather than silently mis-evaluated):
 * arrays and `for (k in a)`, split(), user-defined functions, getline,
 * `print | cmd`, `do … while`.
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
  | { k: 'call'; name: string; args: Node[] };

type Redirect = { mode: '>' | '>>'; target: Node };

type Stmt =
  | { k: 'print'; args: Node[]; redir?: Redirect }
  | { k: 'printf'; args: Node[]; redir?: Redirect }
  | { k: 'expr'; e: Node }
  | { k: 'if'; c: Node; then: Stmt; else?: Stmt }
  | { k: 'while'; c: Node; body: Stmt }
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

// ── Parser ─────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  /** Inside an unparenthesised print argument list, `>` is a redirect. */
  private noGt = false;
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

  parseProgram(): Rule[] {
    const rules: Rule[] = [];
    this.skipTerms();
    while (this.peek().t !== 'eof') {
      if (this.isName('function') || this.isName('func')) throw new AwkError('user-defined functions are not supported');
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
    return rules;
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
          if (this.peek().t === 'name' && this.peek(1).t === 'name' && (this.peek(1) as { v: string }).v === 'in') {
            throw new AwkError('arrays (for … in) are not supported');
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
        case 'do': throw new AwkError('do … while is not supported');
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
        case 'getline': throw new AwkError('getline is not supported');
        case 'delete': throw new AwkError('arrays (delete) are not supported');
        case 'return': throw new AwkError('return outside a function');
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
      if (left.k !== 'var' && left.k !== 'field') throw new AwkError('syntax error: assignment to a non-variable');
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

  private parseIn(): Node {
    const l = this.parseMatch();
    if (this.isName('in')) throw new AwkError('arrays (in) are not supported');
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
    const t = this.peek();
    if (t.t === 'op' && (['<', '<=', '==', '!=', '>='].includes(t.v) || (t.v === '>' && !this.noGt))) {
      this.pos++;
      return { k: 'cmp', op: t.v, l, r: this.parseConcat() };
    }
    return l;
  }

  private startsConcatOperand(): boolean {
    const t = this.peek();
    if (t.t === 'num' || t.t === 'str' || t.t === 'func') return true;
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
    if ((p.k === 'var' || p.k === 'field') && (this.isOp('++') || this.isOp('--'))) {
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
        if (t.v === 'split') throw new AwkError('split() needs arrays, which are not supported');
        if (t.v === 'system' || t.v === 'close') throw new AwkError(`${t.v}() is not supported`);
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
        return { k: 'call', name: t.v, args };
      }
      case 'name': {
        if (t.v === 'getline') throw new AwkError('getline is not supported');
        if (KEYWORDS.has(t.v)) throw new AwkError(`syntax error at '${t.v}'`);
        if (this.isOp('[')) throw new AwkError('arrays are not supported');
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
          if (target.k !== 'var' && target.k !== 'field') throw new AwkError(`syntax error: ${t.v} needs a variable`);
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
          if (items.length > 1) {
            if (this.isName('in')) throw new AwkError('arrays (in) are not supported');
            return { k: 'list', items };
          }
          return { k: 'group', e: items[0] };
        }
        break;
      }
    }
    this.pos--;
    throw new AwkError(`syntax error near ${this.describe()}`);
  }

  private parseIncPrefix(): Node {
    const op = (this.next() as { v: string }).v as '++' | '--';
    const target = this.parsePrimary();
    if (target.k !== 'var' && target.k !== 'field') throw new AwkError(`syntax error: ${op} needs a variable`);
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

class Runtime {
  vars = new Map<string, V>();
  record = '';
  fields: string[] = [];
  private regexCache = new Map<string, RegExp>();
  private opened = new Set<string>();

  constructor(
    private write: (s: string) => void,
    private writeFile: (path: string, s: string, append: boolean) => void,
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

  setRecord(line: string) {
    this.record = line;
    this.split();
  }

  private split() {
    const fs = toStr(this.vars.get('FS') ?? ' ');
    const r = this.record;
    if (fs === ' ') this.fields = r.split(/[ \t\n]+/).filter((f) => f !== '');
    else if (r === '') this.fields = [];
    else if (fs.length === 1 && fs !== '\\') this.fields = r.split(fs);
    else this.fields = r.split(this.regex(fs));
  }

  getVar(name: string): V {
    if (name === 'NF') return this.fields.length;
    return this.vars.get(name) ?? '';
  }

  getField(i: number): string {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) return this.record;
    return this.fields[i - 1] ?? '';
  }

  setField(i: number, v: string) {
    if (i === 0) { this.setRecord(v); return; }
    while (this.fields.length < i) this.fields.push('');
    this.fields[i - 1] = v;
    this.record = this.fields.join(toStr(this.getVar('OFS')));
  }

  private assignTo(target: Node, v: V) {
    if (target.k === 'var') {
      if (target.name === 'NF') {
        const n = Math.trunc(toNum(v));
        this.fields.length = Math.max(0, n);
        for (let k = 0; k < this.fields.length; k++) this.fields[k] ??= '';
        this.record = this.fields.join(toStr(this.getVar('OFS')));
      } else this.vars.set(target.name, v);
    } else if (target.k === 'field') {
      this.setField(Math.trunc(toNum(this.eval(target.e))), toStr(v));
    } else if (target.k === 'group') {
      this.assignTo(target.e, v);
    }
  }

  private isUninit(n: Node): boolean {
    return n.k === 'var' && n.name !== 'NF' && !this.vars.has(n.name);
  }

  /** Does this operand compare numerically (number, or numeric-looking input)? */
  private numericOperand(n: Node, v: V): boolean {
    if (typeof v === 'number') return true;
    if (this.isUninit(n)) return true;
    if (n.k === 'str' || n.k === 'concat' || n.k === 'call') return false;
    return NUMERIC_RE.test(v);
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
      case 'field': return this.getField(Math.trunc(toNum(this.eval(n.e))));
      case 'group': return this.eval(n.e);
      case 'list': throw new AwkError('syntax error: unexpected list');
      case 'assign': {
        let v: V;
        if (n.op === '=') {
          v = this.eval(n.e);
        } else {
          const cur = toNum(this.eval(n.target));
          v = this.arith(n.op[0], cur, toNum(this.eval(n.e)));
        }
        this.assignTo(n.target, v);
        return v;
      }
      case 'cond': return this.test(n.c) ? this.eval(n.a) : this.eval(n.b);
      case 'or': return this.test(n.l) || this.test(n.r) ? 1 : 0;
      case 'and': return this.test(n.l) && this.test(n.r) ? 1 : 0;
      case 'not': return this.test(n.e) ? 0 : 1;
      case 'neg': return -toNum(this.eval(n.e));
      case 'pos': return toNum(this.eval(n.e));
      case 'bin': return this.arith(n.op, toNum(this.eval(n.l)), toNum(this.eval(n.r)));
      case 'concat': return toStr(this.eval(n.l)) + toStr(this.eval(n.r));
      case 'cmp': {
        const l = this.eval(n.l);
        const r = this.eval(n.r);
        let c: number;
        if (this.numericOperand(n.l, l) && this.numericOperand(n.r, r)) {
          const a = toNum(l), b = toNum(r);
          c = a < b ? -1 : a > b ? 1 : 0;
        } else {
          const a = toStr(l), b = toStr(r);
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
        const s = toStr(this.eval(n.l));
        const re = n.r.k === 'regex' ? this.regex(n.r.v) : this.regex(toStr(this.eval(n.r)));
        return re.test(s) !== n.neg ? 1 : 0;
      }
      case 'incdec': {
        const old = toNum(this.eval(n.target));
        const nv = n.op === '++' ? old + 1 : old - 1;
        this.assignTo(n.target, nv);
        return n.pre ? nv : old;
      }
      case 'call': return this.call(n.name, n.args);
    }
  }

  private call(name: string, args: Node[]): V {
    const s = (k: number) => toStr(this.eval(args[k]));
    const num = (k: number) => toNum(this.eval(args[k]));
    switch (name) {
      case 'length': return args.length === 0 ? [...this.record].length : [...s(0)].length;
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
        const target: Node = args[2] ?? { k: 'field', e: { k: 'num', v: 0 } };
        const str = toStr(this.eval(target));
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
        if (count > 0) this.assignTo(target, out);
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
    const path = toStr(this.eval(redir.target));
    const append = redir.mode === '>>' || this.opened.has(path);
    this.opened.add(path);
    this.writeFile(path, text, append);
  }

  private execOne(st: Stmt) {
    switch (st.k) {
      case 'print': {
        const ofs = toStr(this.getVar('OFS'));
        const ors = toStr(this.getVar('ORS'));
        const text = st.args.length === 0 ? this.record : st.args.map((a) => this.outStr(this.eval(a))).join(ofs);
        this.emit(text + ors, st.redir);
        return;
      }
      case 'printf': {
        const vals = st.args.map((a) => this.eval(a));
        this.emit(format(toStr(vals[0]), vals.slice(1)), st.redir);
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
      const ofmt = toStr(this.getVar('OFMT'));
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

  let rules: Rule[];
  try {
    rules = new Parser(tokenize(program)).parseProgram();
  } catch (e) {
    if (e instanceof AwkError) { ctx.stderr.write(`awk: ${e.message}\n`); return 2; }
    throw e;
  }

  const rt = new Runtime(
    (s) => ctx.stdout.write(s),
    (p, s, append) => {
      const path = resolve(ctx.cwd, p);
      const prev = append && ctx.vfs.exists(path) ? ctx.vfs.readFileString(path) : '';
      ctx.vfs.writeFile(path, prev + s);
    },
  );
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

  let exitCode = 0;
  let exiting = false;

  const runRules = (which: 'BEGIN' | 'END') => {
    for (const rule of rules) {
      if (rule.pattern.k !== which || !rule.action) continue;
      rt.exec(rule.action);
    }
  };

  try {
    try {
      runRules('BEGIN');
    } catch (e) {
      if (e instanceof ExitSignal) { exitCode = e.code; exiting = true; }
      else if (!(e instanceof NextSignal)) throw e;
    }

    const hasMain = rules.some((r) => r.pattern.k !== 'BEGIN' && r.pattern.k !== 'END');
    const hasEnd = rules.some((r) => r.pattern.k === 'END');

    if (!exiting && (hasMain || hasEnd)) {
      const inputs: { name: string; text: string }[] = [];
      if (files.length === 0) {
        if (!ctx.stdin) { ctx.stderr.write('awk: missing file operand\n'); return 1; }
        inputs.push({ name: '', text: await ctx.stdin.readAll() });
      } else {
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
      }

      let nr = 0;
      outer: for (const input of inputs) {
        rt.vars.set('FILENAME', input.name);
        if (input.text === '') continue;
        const lines = input.text.replace(/\n$/, '').split('\n');
        let fnr = 0;
        for (const line of lines) {
          nr++;
          fnr++;
          rt.vars.set('NR', nr);
          rt.vars.set('FNR', fnr);
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
            if (e instanceof ExitSignal) { exitCode = e.code; break outer; }
            throw e;
          }
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
    throw e;
  }

  return exitCode;
};

export default command;
