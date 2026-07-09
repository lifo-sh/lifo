import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

/** One address: line number, $ (last line), or /regex/. */
type SedAddress = { kind: 'line'; line: number } | { kind: 'last' } | { kind: 're'; re: RegExp };

interface SedExpr {
  type: 's' | 'd' | 'p' | 'q';
  pattern?: RegExp;
  replacement?: string;
  printOnSub?: boolean;
  addr1?: SedAddress;
  addr2?: SedAddress;
  /** Range state: currently inside an addr1,addr2 window. */
  inRange?: boolean;
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

/** Translate common BRE atoms to JS regex (sed defaults to BRE: \( \) \{ \} \+ \?). */
function breToJs(pattern: string): string {
  return pattern
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')')
    .replace(/\\\{/g, '{').replace(/\\\}/g, '}')
    .replace(/\\\+/g, '+').replace(/\\\?/g, '?')
    .replace(/\\\|/g, '|');
}

/** Parse a sed script (possibly several `;`-separated commands, each with
 *  optional addresses) into SedExpr[]. Returns null on a parse error. */
function parseScript(script: string): SedExpr[] | null {
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
        if (script[i] === '\\' && script[i + 1] === '/') { re += '/'; i += 2; continue; }
        re += script[i++];
      }
      if (script[i] !== '/') return null;
      i++;
      try { return { kind: 're', re: new RegExp(breToJs(re)) }; } catch { return null; }
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
        const a2 = parseAddress();
        if (a2 === null || a2 === undefined) return null;
        expr.addr2 = a2;
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
        if (script[i] === '\\' && script[i + 1] === delim) { current += delim; i += 2; continue; }
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
      try { regex = new RegExp(breToJs(parts[0]), flags); } catch { return null; }

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
    a.kind === 'last' ? lineNo === lastLineNo : a.kind === 'line' ? lineNo === a.line : a.re.test(line);
  if (!expr.addr1) return true;
  if (!expr.addr2) return test(expr.addr1);
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
      // ERE: our breToJs translation makes BRE behave like ERE already, and
      // plain ERE patterns pass through JS regex — accepted as a no-op.
      continue;
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
    const parsed = parseScript(s);
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
