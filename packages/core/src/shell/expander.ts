import type { WordPart } from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import { expandGlob, globMatch } from '../utils/glob.js';

export interface ExpandContext {
  env: Record<string, string>;
  lastExitCode: number;
  cwd: string;
  vfs: VFS;
  executeCapture?: (input: string) => Promise<string>;
  /** `$$`: the shell's process id. */
  pid?: number;
  /** `$!`: the process id of the last background job. */
  lastBackgroundPid?: number;
}

/**
 * Expand all words for a command's arguments.
 * Handles variable expansion, tilde expansion, glob expansion, and command substitution.
 */
export async function expandWords(words: WordPart[][], ctx: ExpandContext): Promise<string[]> {
  const results: string[] = [];

  for (const word of words.flatMap(braceExpand)) {
    const expanded = await expandWordParts(word, ctx);

    // An unquoted word that expands to nothing (`$UNSET`, `$(true)`) is removed, as in POSIX sh.
    // A word with any quoted part (`""`, `''`, `"$UNSET"`) stays, as an empty argument.
    if (expanded === '' && word.every((part) => part.quoted === 'none')) continue;

    // Glob expansion only for unquoted parts
    if (hasUnquotedGlob(word, expanded)) {
      const globResults = expandGlob(expanded, ctx.cwd, ctx.vfs);
      results.push(...globResults);
    } else {
      results.push(expanded);
    }
  }

  return results;
}

// ─── Brace expansion ───

type QChar = { c: string; q: WordPart['quoted'] };

/**
 * Brace expansion, done first as in bash: `a{b,c}d` → `abd acd`, `{1..5}`, `{a..e}`,
 * `{01..10..3}`, nested `{a,b{c,d}}`. Only unquoted braces and commas count, and `${…}` / `$(…)`
 * are left alone. A brace with no comma and no valid range (`{}`, `{x}`) stays literal.
 */
export function braceExpand(word: WordPart[]): WordPart[][] {
  if (!word.some((p) => p.quoted === 'none' && p.text.includes('{'))) return [word];
  const chars: QChar[] = [];
  for (const part of word) for (const c of part.text) chars.push({ c, q: part.quoted });
  return expandChars(chars, 0).map(toParts);
}

function toParts(chars: QChar[]): WordPart[] {
  const parts: WordPart[] = [];
  for (const { c, q } of chars) {
    const last = parts[parts.length - 1];
    if (last && last.quoted === q) last.text += c;
    else parts.push({ text: c, quoted: q });
  }
  return parts.length > 0 ? parts : [{ text: '', quoted: 'none' }];
}

const isOpen = (ch: QChar | undefined, c: string) => ch !== undefined && ch.q === 'none' && ch.c === c;

/** Skips a `${…}` or `$(…)` starting at the `$` at index i; returns the index after it. */
function skipDollar(chars: QChar[], i: number): number {
  const open = chars[i + 1].c;
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let j = i + 1; j < chars.length; j++) {
    if (chars[j].c === open) depth++;
    else if (chars[j].c === close && --depth === 0) return j + 1;
  }
  return chars.length;
}

function expandChars(chars: QChar[], from: number): QChar[][] {
  for (let i = from; i < chars.length; i++) {
    if (isOpen(chars[i], '$') && (isOpen(chars[i + 1], '{') || isOpen(chars[i + 1], '('))) {
      i = skipDollar(chars, i) - 1;
      continue;
    }
    if (!isOpen(chars[i], '{')) continue;

    // Find the matching close brace and the top-level commas.
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let j = i; j < chars.length; j++) {
      if (isOpen(chars[j], '$') && (isOpen(chars[j + 1], '{') || isOpen(chars[j + 1], '('))) {
        j = skipDollar(chars, j) - 1;
        continue;
      }
      if (isOpen(chars[j], '{')) depth++;
      else if (isOpen(chars[j], '}') && --depth === 0) {
        close = j;
        break;
      } else if (depth === 1 && isOpen(chars[j], ',')) commas.push(j);
    }
    if (close === -1) return [chars];

    const prefix = chars.slice(0, i);
    const suffix = chars.slice(close + 1);
    let alternatives: QChar[][] | null = null;
    if (commas.length > 0) {
      alternatives = [];
      let start = i + 1;
      for (const comma of [...commas, close]) {
        alternatives.push(chars.slice(start, comma));
        start = comma + 1;
      }
    } else {
      const inner = chars.slice(i + 1, close);
      if (inner.every((ch) => ch.q === 'none')) {
        const seq = braceSequence(inner.map((ch) => ch.c).join(''));
        if (seq) alternatives = seq.map((text) => [...text].map((c) => ({ c, q: 'none' as const })));
      }
    }
    if (!alternatives) continue; // not an expansion: keep the '{' literal and look further on

    const out: QChar[][] = [];
    for (const alt of alternatives) {
      // The prefix has no expansions left, so rescanning can start after it.
      out.push(...expandChars([...prefix, ...alt, ...suffix], prefix.length));
    }
    return out;
  }
  return [chars];
}

/** `1..5`, `5..1`, `1..10..3`, `01..10` (zero-padded) and `a..e`; null if it isn't a range. */
function braceSequence(text: string): string[] | null {
  const num = text.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (num) {
    const a = parseInt(num[1], 10);
    const b = parseInt(num[2], 10);
    const step = Math.abs(parseInt(num[3] ?? '1', 10)) || 1;
    const padded = /^-?0\d/.test(num[1]) || /^-?0\d/.test(num[2]);
    const width = padded ? Math.max(num[1].length, num[2].length) : 0;
    const out: string[] = [];
    for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? step : -step) {
      const s = String(Math.abs(n)).padStart(width - (n < 0 ? 1 : 0), '0');
      out.push(n < 0 ? '-' + s : s);
      if (out.length > 100_000) break;
    }
    return out;
  }
  const alpha = text.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
  if (alpha) {
    const a = alpha[1].charCodeAt(0);
    const b = alpha[2].charCodeAt(0);
    const step = Math.abs(parseInt(alpha[3] ?? '1', 10)) || 1;
    const out: string[] = [];
    for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? step : -step) out.push(String.fromCharCode(n));
    return out;
  }
  return null;
}

/**
 * Expand a single word (e.g., for redirect targets).
 * No glob expansion.
 */
export async function expandWord(parts: WordPart[], ctx: ExpandContext): Promise<string> {
  return expandWordParts(parts, ctx);
}

async function expandWordParts(parts: WordPart[], ctx: ExpandContext): Promise<string> {
  let result = '';

  for (const part of parts) {
    switch (part.quoted) {
      case 'single':
        // Single quotes: literal, no expansion
        result += part.text;
        break;

      case 'double':
        // Double quotes: expand variables and command substitution, no glob
        result += await expandVariablesAndSubst(part.text, ctx);
        break;

      case 'none': {
        // Unquoted: expand tilde, variables, command substitution
        let text = part.text;

        // Tilde expansion at word start
        if (result === '' && text.startsWith('~')) {
          const home = ctx.env['HOME'] ?? '/home/user';
          if (text === '~') {
            text = home;
          } else if (text.startsWith('~/')) {
            text = home + text.slice(1);
          }
        }

        text = await expandVariablesAndSubst(text, ctx);
        result += text;
        break;
      }
    }
  }

  return result;
}

async function expandVariablesAndSubst(text: string, ctx: ExpandContext): Promise<string> {
  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '$') {
      const expanded = await expandDollar(text, i, ctx);
      result += expanded.value;
      i = expanded.end;
    } else {
      result += text[i];
      i++;
    }
  }

  return result;
}

async function expandDollar(
  text: string, pos: number, ctx: ExpandContext,
): Promise<{ value: string; end: number }> {
  const next = text[pos + 1];

  if (next === undefined) {
    return { value: '$', end: pos + 1 };
  }

  // $? -- last exit code
  if (next === '?') {
    return { value: String(ctx.lastExitCode), end: pos + 2 };
  }

  // $# -- number of positional parameters
  if (next === '#') {
    return { value: ctx.env['#'] ?? '0', end: pos + 2 };
  }

  // $$ -- the shell's pid; $! -- the last background job's pid
  if (next === '$') {
    return { value: String(ctx.pid ?? 1), end: pos + 2 };
  }
  if (next === '!') {
    return { value: ctx.lastBackgroundPid !== undefined ? String(ctx.lastBackgroundPid) : '', end: pos + 2 };
  }

  // $@ -- all positional parameters
  if (next === '@') {
    return { value: ctx.env['@'] ?? '', end: pos + 2 };
  }

  // $((...)) -- arithmetic expansion
  if (next === '(' && text[pos + 2] === '(') {
    // Find matching ))
    let depth = 1;
    let j = pos + 3;
    while (j < text.length && depth > 0) {
      if (text[j] === '(' && text[j + 1] === '(') {
        depth++;
        j += 2;
      } else if (text[j] === ')' && text[j + 1] === ')') {
        depth--;
        if (depth === 0) {
          j += 2;
          break;
        }
        j += 2;
      } else {
        j++;
      }
    }
    const expr = text.slice(pos + 3, j - 2);
    const result = evaluateArithmetic(expr, ctx.env);
    return { value: String(result), end: j };
  }

  // $(...) -- command substitution
  if (next === '(') {
    let depth = 1;
    let j = pos + 2;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
      j++;
    }
    const cmd = text.slice(pos + 2, j - 1);
    let output = '';
    if (ctx.executeCapture) {
      output = await ctx.executeCapture(cmd);
      // Trim trailing newlines (bash behavior)
      output = output.replace(/\n+$/, '');
    }
    return { value: output, end: j };
  }

  // ${...} -- braced variable
  if (next === '{') {
    let j = pos + 2;
    let depth = 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const inner = text.slice(pos + 2, j - 1);
    const value = expandBracedVar(inner, ctx);
    return { value, end: j };
  }

  // $N -- positional parameters (single digit)
  if (/[0-9]/.test(next)) {
    return { value: ctx.env[next] ?? '', end: pos + 2 };
  }

  // $VAR -- simple variable
  if (/[a-zA-Z_]/.test(next)) {
    let j = pos + 1;
    while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) {
      j++;
    }
    const name = text.slice(pos + 1, j);
    if (name === 'RANDOM' && ctx.env[name] === undefined) {
      return { value: String(Math.floor(Math.random() * 32768)), end: j };
    }
    return { value: ctx.env[name] ?? '', end: j };
  }

  // Unrecognized $ sequence -- literal
  return { value: '$', end: pos + 1 };
}

function expandBracedVar(inner: string, ctx: ExpandContext): string {
  // ${#VAR} -- string length
  if (inner.startsWith('#') && /^#[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner)) {
    const varName = inner.slice(1);
    const val = ctx.env[varName] ?? '';
    return String(val.length);
  }

  // ${VAR:offset:length} and ${VAR:offset}
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(-?\d+)(?::(\d+))?$/);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      let offset = parseInt(match[2], 10);
      if (offset < 0) offset = Math.max(0, val.length + offset);
      if (match[3] !== undefined) {
        const length = parseInt(match[3], 10);
        return val.slice(offset, offset + length);
      }
      return val.slice(offset);
    }
  }

  // ${VAR:-default}
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*):-(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]];
      return (val !== undefined && val !== '') ? val : match[2];
    }
  }

  // ${VAR:=default} -- assign default if unset/empty
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*):=(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]];
      if (val !== undefined && val !== '') return val;
      ctx.env[match[1]] = match[2];
      return match[2];
    }
  }

  // ${VAR:+alternative}
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\+(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]];
      return (val !== undefined && val !== '') ? match[2] : '';
    }
  }

  // ${VAR:?message} -- error if unset/empty
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\?(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]];
      if (val !== undefined && val !== '') return val;
      throw new Error(`${match[1]}: ${match[2] || 'parameter null or not set'}`);
    }
  }

  // ${VAR//pattern/replacement} -- replace all (must check before single /)
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\/\/([^/]*)\/(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      const pattern = match[2];
      const replacement = match[3];
      return replaceAll(val, pattern, replacement);
    }
  }

  // ${VAR/pattern/replacement} -- replace first
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\/([^/]*)\/(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      const pattern = match[2];
      const replacement = match[3];
      return replaceFirst(val, pattern, replacement);
    }
  }

  // ${VAR##pattern} -- remove longest prefix (must check before single #)
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*)##(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      const pattern = match[2];
      // Try longest prefix first
      for (let i = val.length; i >= 0; i--) {
        if (globMatch(pattern, val.slice(0, i))) {
          return val.slice(i);
        }
      }
      return val;
    }
  }

  // ${VAR#pattern} -- remove shortest prefix
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*)#(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      const pattern = match[2];
      for (let i = 0; i <= val.length; i++) {
        if (globMatch(pattern, val.slice(0, i))) {
          return val.slice(i);
        }
      }
      return val;
    }
  }

  // ${VAR%%pattern} -- remove longest suffix (must check before single %)
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*)%%(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      const pattern = match[2];
      for (let i = 0; i <= val.length; i++) {
        if (globMatch(pattern, val.slice(i))) {
          return val.slice(0, i);
        }
      }
      return val;
    }
  }

  // ${VAR%pattern} -- remove shortest suffix
  {
    const match = inner.match(/^([a-zA-Z_][a-zA-Z0-9_]*)%(.*)$/s);
    if (match) {
      const val = ctx.env[match[1]] ?? '';
      const pattern = match[2];
      for (let i = val.length; i >= 0; i--) {
        if (globMatch(pattern, val.slice(i))) {
          return val.slice(0, i);
        }
      }
      return val;
    }
  }

  // ${VAR} -- simple
  return ctx.env[inner] ?? '';
}

function replaceFirst(val: string, pattern: string, replacement: string): string {
  for (let i = 0; i < val.length; i++) {
    for (let j = i + 1; j <= val.length; j++) {
      if (globMatch(pattern, val.slice(i, j))) {
        return val.slice(0, i) + replacement + val.slice(j);
      }
    }
  }
  return val;
}

function replaceAll(val: string, pattern: string, replacement: string): string {
  let result = '';
  let i = 0;
  while (i < val.length) {
    let matched = false;
    for (let j = i + 1; j <= val.length; j++) {
      if (globMatch(pattern, val.slice(i, j))) {
        result += replacement;
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += val[i];
      i++;
    }
  }
  return result;
}

function hasUnquotedGlob(parts: WordPart[], _expanded: string): boolean {
  // Check if any unquoted part contains glob characters
  for (const part of parts) {
    if (part.quoted === 'none') {
      if (part.text.includes('*') || part.text.includes('?') || part.text.includes('[')) {
        return true;
      }
    }
  }
  return false;
}

// ─── Arithmetic evaluator ───

function evaluateArithmetic(expr: string, env: Record<string, string>): number {
  const parser = new ArithParser(expr.trim(), env);
  const result = parser.parseExpression();
  return result;
}

class ArithParser {
  private expr: string;
  private pos = 0;
  private env: Record<string, string>;

  constructor(expr: string, env: Record<string, string>) {
    this.expr = expr;
    this.env = env;
  }

  private skipSpaces(): void {
    while (this.pos < this.expr.length && (this.expr[this.pos] === ' ' || this.expr[this.pos] === '\t')) {
      this.pos++;
    }
  }

  private peek(): string {
    this.skipSpaces();
    return this.expr[this.pos] ?? '';
  }

  private peekNext(): string {
    return this.expr[this.pos + 1] ?? '';
  }

  parseExpression(): number {
    return this.parseTernary();
  }

  private parseTernary(): number {
    const cond = this.parseLogicalOr();
    this.skipSpaces();
    if (this.peek() === '?') {
      this.pos++;
      const truePart = this.parseTernary();
      this.skipSpaces();
      if (this.peek() === ':') {
        this.pos++;
        const falsePart = this.parseTernary();
        return cond ? truePart : falsePart;
      }
    }
    return cond;
  }

  private parseLogicalOr(): number {
    let left = this.parseLogicalAnd();
    while (true) {
      this.skipSpaces();
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '|' && this.expr[this.pos + 1] === '|') {
        this.pos += 2;
        const right = this.parseLogicalAnd();
        left = (left || right) ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseLogicalAnd(): number {
    let left = this.parseBitwiseOr();
    while (true) {
      this.skipSpaces();
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '&' && this.expr[this.pos + 1] === '&') {
        this.pos += 2;
        const right = this.parseBitwiseOr();
        left = (left && right) ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseBitwiseOr(): number {
    let left = this.parseBitwiseXor();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '|' && this.expr[this.pos + 1] !== '|') {
        this.pos++;
        const right = this.parseBitwiseXor();
        left = left | right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseBitwiseXor(): number {
    let left = this.parseBitwiseAnd();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '^') {
        this.pos++;
        const right = this.parseBitwiseAnd();
        left = left ^ right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseBitwiseAnd(): number {
    let left = this.parseEquality();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '&' && this.expr[this.pos + 1] !== '&') {
        this.pos++;
        const right = this.parseEquality();
        left = left & right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseEquality(): number {
    let left = this.parseRelational();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '=' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseRelational();
        left = left === right ? 1 : 0;
      } else if (this.expr[this.pos] === '!' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseRelational();
        left = left !== right ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseRelational(): number {
    let left = this.parseShift();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseShift();
        left = left <= right ? 1 : 0;
      } else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] === '=') {
        this.pos += 2;
        const right = this.parseShift();
        left = left >= right ? 1 : 0;
      } else if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] !== '<') {
        this.pos++;
        const right = this.parseShift();
        left = left < right ? 1 : 0;
      } else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] !== '>') {
        this.pos++;
        const right = this.parseShift();
        left = left > right ? 1 : 0;
      } else {
        break;
      }
    }
    return left;
  }

  private parseShift(): number {
    let left = this.parseAddition();
    while (true) {
      this.skipSpaces();
      if (this.expr[this.pos] === '<' && this.expr[this.pos + 1] === '<') {
        this.pos += 2;
        const right = this.parseAddition();
        left = left << right;
      } else if (this.expr[this.pos] === '>' && this.expr[this.pos + 1] === '>') {
        this.pos += 2;
        const right = this.parseAddition();
        left = left >> right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseAddition(): number {
    let left = this.parseMultiplication();
    while (true) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '+' && this.peekNext() !== '+') {
        this.pos++;
        const right = this.parseMultiplication();
        left = left + right;
      } else if (ch === '-' && this.peekNext() !== '-') {
        this.pos++;
        const right = this.parseMultiplication();
        left = left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseMultiplication(): number {
    let left = this.parseExponentiation();
    while (true) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '*' && this.peekNext() !== '*') {
        this.pos++;
        const right = this.parseExponentiation();
        left = left * right;
      } else if (ch === '/' ) {
        this.pos++;
        const right = this.parseExponentiation();
        if (right === 0) return 0;
        left = Math.trunc(left / right);
      } else if (ch === '%') {
        this.pos++;
        const right = this.parseExponentiation();
        if (right === 0) return 0;
        left = left % right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseExponentiation(): number {
    const base = this.parseUnary();
    this.skipSpaces();
    if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '*' && this.expr[this.pos + 1] === '*') {
      this.pos += 2;
      const exp = this.parseExponentiation(); // right-associative
      return Math.pow(base, exp) | 0;
    }
    return base;
  }

  private parseUnary(): number {
    this.skipSpaces();
    const ch = this.peek();

    if (ch === '!') {
      this.pos++;
      const val = this.parseUnary();
      return val ? 0 : 1;
    }
    if (ch === '~') {
      this.pos++;
      const val = this.parseUnary();
      return ~val;
    }
    if (ch === '-') {
      this.pos++;
      const val = this.parseUnary();
      return -val;
    }
    if (ch === '+') {
      this.pos++;
      return this.parseUnary();
    }

    // Pre-increment/decrement
    if (ch === '+' && this.peekNext() === '+') {
      this.pos += 2;
      this.skipSpaces();
      const name = this.readVarName();
      if (name) {
        const val = this.getVar(name) + 1;
        this.env[name] = String(val);
        return val;
      }
    }
    if (ch === '-' && this.peekNext() === '-') {
      this.pos += 2;
      this.skipSpaces();
      const name = this.readVarName();
      if (name) {
        const val = this.getVar(name) - 1;
        this.env[name] = String(val);
        return val;
      }
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipSpaces();
    const ch = this.peek();

    // Parenthesized expression
    if (ch === '(') {
      this.pos++;
      const val = this.parseExpression();
      this.skipSpaces();
      if (this.peek() === ')') this.pos++;
      return val;
    }

    // Number literal
    if (/[0-9]/.test(ch)) {
      return this.readNumber();
    }

    // $VAR reference -- skip the $ and read variable name
    if (ch === '$') {
      this.pos++;
      this.skipSpaces();
      const name = this.readVarName();
      if (name) return this.getVar(name);
      return 0;
    }

    // Variable reference (possibly with post-increment)
    if (/[a-zA-Z_]/.test(ch)) {
      const name = this.readVarName();
      if (!name) return 0;
      this.skipSpaces();

      // Post-increment/decrement
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '+' && this.expr[this.pos + 1] === '+') {
        this.pos += 2;
        const val = this.getVar(name);
        this.env[name] = String(val + 1);
        return val;
      }
      if (this.pos + 1 < this.expr.length && this.expr[this.pos] === '-' && this.expr[this.pos + 1] === '-') {
        this.pos += 2;
        const val = this.getVar(name);
        this.env[name] = String(val - 1);
        return val;
      }

      // Assignment within arithmetic (but not == comparison)
      if (this.expr[this.pos] === '=' && this.expr[this.pos + 1] !== '=') {
        this.pos++;
        const val = this.parseExpression();
        this.env[name] = String(val);
        return val;
      }

      return this.getVar(name);
    }

    return 0;
  }

  private readNumber(): number {
    let num = '';
    while (this.pos < this.expr.length && /[0-9]/.test(this.expr[this.pos])) {
      num += this.expr[this.pos];
      this.pos++;
    }
    return parseInt(num, 10) || 0;
  }

  private readVarName(): string | null {
    let name = '';
    while (this.pos < this.expr.length && /[a-zA-Z0-9_]/.test(this.expr[this.pos])) {
      name += this.expr[this.pos];
      this.pos++;
    }
    return name || null;
  }

  private getVar(name: string): number {
    const val = this.env[name];
    if (val === undefined) return 0;
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }
}
