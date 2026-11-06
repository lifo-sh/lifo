import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

/** One address: line number, $ (last line), or /regex/. */
type SedAddress =
  | { kind: 'line'; line: number }
  | { kind: 'last' }
  | { kind: 're'; re: RegExp }
  /** GNU `addr1,+N`: addr1 and the N lines after it (second address only). */
  | { kind: 'plus'; count: number };

interface SedExpr {
  type: 's' | 'd' | 'p' | 'q';
  pattern?: RegExp;
  replacement?: string;
  printOnSub?: boolean;
  addr1?: SedAddress;
  addr2?: SedAddress;
  /** Range state: currently inside an addr1,addr2 window. */
  inRange?: boolean;
  /** For `addr1,+N`: last line number of the current window. */
  rangeEnd?: number;
}

/** Convert a sed replacement to JS `String.replace` syntax:
 *  `&` → `$&`, `\1` → `$1`, `\&` → literal &, `$` → `$$`. */
function convertReplacement(rep: string): string {
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '\\') {
      const n = rep[i + 1];
      if (n >= '1' && n <= '9') { out += '$' + n; i++; continue; }
      if (n === '&') { out += '&'; i++; continue; }
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      continue; // lone backslash escapes the next char
    }
    if (c === '$') { out += '$$'; continue; }
    if (c === '&') { out += '$&'; continue; }
    out += c;
  }
  return out;
}

/** JS character-class bodies for POSIX bracket classes like `[[:space:]]`. */
const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
  word: '\\w',
};

/** Characters that are special in ERE but literal in BRE (their escaped
 *  forms are the special ones in BRE, GNU-style). */
const BRE_SWAPPED = '(){}|+?';

/** Translate a POSIX bracket expression starting at `p[start] === '['`.
 *  Returns the JS class and the index just past the closing `]`, or null if
 *  the bracket never closes. Inside brackets only `]` (when not first), `^`
 *  (when first), `-` and `[:class:]` are special; a backslash is literal
 *  except for the GNU `\n`, `\t`, `\\` and `\]` escapes. */
function translateBracket(p: string, start: number): { js: string; end: number } | null {
  let i = start + 1;
  let out = '[';
  if (p[i] === '^') { out += '^'; i++; }
  let first = true;
  while (i < p.length) {
    const c = p[i];
    if (c === ']' && !first) return { js: out + ']', end: i + 1 };
    first = false;
    if (c === '[' && (p[i + 1] === ':' || p[i + 1] === '.' || p[i + 1] === '=')) {
      const kind = p[i + 1];
      const close = p.indexOf(kind + ']', i + 2);
      if (close === -1) return null;
      const name = p.slice(i + 2, close);
      if (kind === ':') {
        const cls = POSIX_CLASSES[name];
        if (cls === undefined) return null;
        out += cls;
      } else {
        // Collating symbol / equivalence class: treat as the literal text.
        for (const ch of name) out += '\\' + ch;
      }
      i = close + 2;
      continue;
    }
    if (c === '\\') {
      const n = p[i + 1];
      if (n === 'n') { out += '\\n'; i += 2; continue; }
      if (n === 't') { out += '\\t'; i += 2; continue; }
      if (n === '\\') { out += '\\\\'; i += 2; continue; }
      if (n === ']') { out += '\\]'; i += 2; continue; }
      out += '\\\\'; i++; continue; // literal backslash
    }
    if (c === '[' || c === ']') { out += '\\' + c; i++; continue; }
    out += c;
    i++;
  }
  return null;
}

/** Translate a POSIX regex (BRE by default, ERE with -E/-r) to JS RegExp
 *  source. In BRE, unescaped `( ) { } | + ?` are literal and `\( \) \{ \}
 *  \| \+ \?` are special; in ERE it is the other way round. `delim` is the
 *  `s`/address delimiter: `\<delim>` always means that character literally. */
export function posixToJs(pattern: string, ere = false, delim?: string): string {
  let out = '';
  // At the start of the regex or a group/alternative: `*` is literal and
  // (in BRE) `^` is an anchor.
  let atStart = true;
  let i = 0;
  const lit = (ch: string) => (/[\\^$.*+?()[\]{}|\/-]/.test(ch) ? '\\' + ch : ch);
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === undefined) { out += '\\\\'; i++; continue; }
      i += 2;
      if (delim !== undefined && n === delim) { out += lit(n); atStart = false; continue; }
      if (BRE_SWAPPED.includes(n)) {
        if (ere) { out += '\\' + n; atStart = false; continue; }
        out += n;
        atStart = n === '(' || n === '|';
        continue;
      }
      if (n === '<' || n === '>') { out += '\\b'; continue; }
      if (n === '`') { out += '^'; continue; }
      if (n === "'") { out += '$'; continue; }
      out += '\\' + n; // \. \* \[ \1 \n \t \w \s \b ...
      atStart = false;
      continue;
    }
    if (c === '[') {
      const br = translateBracket(pattern, i);
      if (!br) { out += '\\['; i++; atStart = false; continue; }
      out += br.js;
      i = br.end;
      atStart = false;
      continue;
    }
    if (c === '*' && atStart) { out += '\\*'; i++; atStart = false; continue; }
    if (c === '^') {
      if (ere || atStart) { out += '^'; i++; continue; } // still at start: `^*` → literal *
      out += '\\^'; i++; continue;
    }
    if (c === '$') {
      const rest = pattern.slice(i + 1);
      if (ere || rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')) { out += '$'; i++; continue; }
      out += '\\$'; i++; atStart = false; continue;
    }
    if (ere && atStart && (c === '+' || c === '?' || c === '{')) { out += '\\' + c; i++; atStart = false; continue; }
    if (!ere && BRE_SWAPPED.includes(c)) { out += '\\' + c; i++; atStart = false; continue; }
    if (ere && (c === '(' || c === '|')) { out += c; i++; atStart = true; continue; }
    if (c === '/') { out += '\\/'; i++; atStart = false; continue; }
    out += c;
    i++;
    atStart = false;
  }
  return out;
}

/** Parse a sed script (possibly several `;`-separated commands, each with
 *  optional addresses) into SedExpr[]. Returns null on a parse error. */
function parseScript(script: string, ere = false): SedExpr[] | null {
  const exprs: SedExpr[] = [];
  let i = 0;
  const len = script.length;

  const skipBlank = () => { while (i < len && (script[i] === ';' || script[i] === ' ' || script[i] === '\t')) i++; };

  const parseAddress = (): SedAddress | null | undefined => {
    // undefined = no address present; null = parse error
    const c = script[i];
    if (c === '$') { i++; return { kind: 'last' }; }
    if (c >= '0' && c <= '9') {
      let n = '';
      while (i < len && script[i] >= '0' && script[i] <= '9') n += script[i++];
      return { kind: 'line', line: parseInt(n, 10) };
    }
    if (c === '/') {
      i++;
      let re = '';
      while (i < len && script[i] !== '/') {
        if (script[i] === '\\' && i + 1 < len) { re += script[i] + script[i + 1]; i += 2; continue; }
        re += script[i++];
      }
      if (script[i] !== '/') return null;
      i++;
      try { return { kind: 're', re: new RegExp(posixToJs(re, ere, '/')) }; } catch { return null; }
    }
    return undefined;
  };

  while (i < len) {
    skipBlank();
    if (i >= len) break;

    const expr: SedExpr = { type: 'p' };
    const a1 = parseAddress();
    if (a1 === null) return null;
    if (a1 !== undefined) {
      expr.addr1 = a1;
      if (script[i] === ',') {
        i++;
        if (script[i] === '+') {
          // GNU `addr1,+N`
          i++;
          let n = '';
          while (i < len && script[i] >= '0' && script[i] <= '9') n += script[i++];
          if (!n) return null;
          expr.addr2 = { kind: 'plus', count: parseInt(n, 10) };
        } else {
          const a2 = parseAddress();
          if (a2 === null || a2 === undefined) return null;
          expr.addr2 = a2;
        }
      }
    }
    skipBlank();

    const cmd = script[i];
    if (cmd === 'd' || cmd === 'p' || cmd === 'q') {
      expr.type = cmd;
      i++;
      exprs.push(expr);
      continue;
    }
    if (cmd === 's') {
      i++;
      const delim = script[i];
      if (!delim) return null;
      i++;
      const parts: string[] = [];
      let current = '';
      while (i < len && parts.length < 2) {
        // In the pattern keep `\<delim>` so posixToJs reads it as a literal
        // delimiter; in the replacement it is just the delimiter character.
        if (script[i] === '\\' && script[i + 1] === delim) { current += parts.length === 0 ? '\\' + delim : delim; i += 2; continue; }
        if (script[i] === '\\') { current += script[i] + (script[i + 1] ?? ''); i += 2; continue; }
        if (script[i] === delim) { parts.push(current); current = ''; i++; continue; }
        current += script[i++];
      }
      if (parts.length < 2) return null;
      // flags run until ; or end
      let flagStr = '';
      while (i < len && script[i] !== ';') flagStr += script[i++];
      flagStr = flagStr.trim();

      let flags = '';
      if (flagStr.includes('g')) flags += 'g';
      if (flagStr.includes('i') || flagStr.includes('I')) flags += 'i';
      let regex: RegExp;
      try { regex = new RegExp(posixToJs(parts[0], ere, delim), flags); } catch { return null; }

      expr.type = 's';
      expr.pattern = regex;
      expr.replacement = convertReplacement(parts[1]);
      expr.printOnSub = flagStr.includes('p');
      exprs.push(expr);
      continue;
    }
    return null; // unknown command
  }
  return exprs;
}

/** Does this expression apply to the current line? Handles single addresses
 *  and stateful addr1,addr2 ranges. */
function matches(expr: SedExpr, line: string, lineNo: number, lastLineNo: number): boolean {
  const test = (a: SedAddress): boolean =>
    a.kind === 'last' ? lineNo === lastLineNo
      : a.kind === 'line' ? lineNo === a.line
      : a.kind === 're' ? a.re.test(line)
      : false;
  if (!expr.addr1) return true;
  if (!expr.addr2) return test(expr.addr1);
  if (expr.addr2.kind === 'plus') {
    if (expr.inRange) {
      if (lineNo >= (expr.rangeEnd ?? 0)) expr.inRange = false;
      return true;
    }
    if (test(expr.addr1)) {
      expr.rangeEnd = lineNo + expr.addr2.count;
      expr.inRange = expr.addr2.count > 0;
      return true;
    }
    return false;
  }
  // Range: turns on at addr1, off after addr2.
  if (expr.inRange) {
    if (test(expr.addr2) || (expr.addr2.kind === 'line' && lineNo >= expr.addr2.line)) expr.inRange = false;
    return true;
  }
  if (test(expr.addr1)) {
    expr.inRange = !(test(expr.addr2) && expr.addr2.kind !== 'line');
    if (expr.addr2.kind === 'line' && expr.addr2.line <= lineNo) expr.inRange = false;
    return true;
  }
  return false;
}

const command: Command = async (ctx) => {
  let inPlace = false;
  let suppress = false; // -n
  let ere = false; // -E / -r
  const scripts: string[] = [];
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-i' || arg.startsWith('-i')) {
      inPlace = true;
      // BSD form: `-i ''` (empty backup suffix as separate arg) — consume it.
      if (arg === '-i' && ctx.args[i + 1] === '') i++;
      // GNU form: `-i.bak` — backup suffix attached; we don't write backups.
    } else if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
      suppress = true;
    } else if ((arg === '-e' || arg === '--expression') && i + 1 < ctx.args.length) {
      scripts.push(ctx.args[++i]);
    } else if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      ere = true;
    } else if (scripts.length === 0 && !arg.startsWith('-')) {
      scripts.push(arg);
    } else {
      files.push(arg);
    }
  }

  if (scripts.length === 0) {
    ctx.stderr.write('sed: missing expression\n');
    return 1;
  }

  const parsedExprs: SedExpr[] = [];
  for (const s of scripts) {
    const parsed = parseScript(s, ere);
    if (!parsed) {
      ctx.stderr.write(`sed: invalid expression: ${s}\n`);
      return 1;
    }
    parsedExprs.push(...parsed);
  }

  function processText(text: string): string {
    const hadTrailingNewline = text.endsWith('\n');
    const lines = text.replace(/\n$/, '').split('\n');
    const output: string[] = [];
    // Reset range state per file.
    for (const e of parsedExprs) e.inRange = false;

    let quit = false;
    for (let idx = 0; idx < lines.length && !quit; idx++) {
      let line = lines[idx];
      const lineNo = idx + 1;
      let deleted = false;
      for (const expr of parsedExprs) {
        if (!matches(expr, line, lineNo, lines.length)) continue;
        if (expr.type === 's' && expr.pattern && expr.replacement !== undefined) {
          const before = line;
          line = line.replace(expr.pattern, expr.replacement);
          if (expr.printOnSub && line !== before) output.push(line);
        } else if (expr.type === 'd') {
          deleted = true;
          break;
        } else if (expr.type === 'p') {
          output.push(line);
        } else if (expr.type === 'q') {
          quit = true;
        }
      }
      if (!deleted && !suppress) output.push(line);
    }

    if (output.length === 0) return '';
    return output.join('\n') + (hadTrailingNewline || output.length > 0 ? '\n' : '');
  }

  if (files.length === 0) {
    if (ctx.stdin) {
      const text = await ctx.stdin.readAll();
      ctx.stdout.write(processText(text));
    } else {
      ctx.stderr.write('sed: missing file operand\n');
      return 1;
    }
    return 0;
  }

  let exitCode = 0;
  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      ctx.vfs.stat(path);
      if (isBinaryMime(getMimeType(path))) {
        ctx.stderr.write(`sed: ${file}: binary file, skipping\n`);
        continue;
      }
      const content = ctx.vfs.readFileString(path);
      const result = processText(content);
      if (inPlace) {
        ctx.vfs.writeFile(path, result);
      } else {
        ctx.stdout.write(result);
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`sed: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
