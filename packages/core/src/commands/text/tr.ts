import type { Command } from '../types.js';

/** Characters for each POSIX class, in ascending (C locale) order. */
function classChars(name: string): string | null {
  const range = (from: number, to: number) => {
    let s = '';
    for (let c = from; c <= to; c++) s += String.fromCharCode(c);
    return s;
  };
  const upper = range(65, 90);
  const lower = range(97, 122);
  const digit = range(48, 57);
  const all = range(0, 255);
  const pick = (re: RegExp) => [...all].filter((c) => c.charCodeAt(0) < 128 && re.test(c)).join('');
  switch (name) {
    case 'alpha': return upper + lower;
    case 'digit': return digit;
    case 'alnum': return digit + upper + lower;
    case 'upper': return upper;
    case 'lower': return lower;
    case 'space': return '\t\n\v\f\r ';
    case 'blank': return '\t ';
    case 'punct': return pick(/[!-\/:-@[-`{-~]/);
    case 'print': return range(32, 126);
    case 'graph': return range(33, 126);
    case 'cntrl': return range(0, 31) + '\x7f';
    case 'xdigit': return digit + 'ABCDEF' + 'abcdef';
    default: return null;
  }
}

class TrError extends Error {}

/** One parsed element of a SET: a literal char or a `[c*n]` repeat (n = 0
 *  means "fill", only meaningful in SET2). */
type Elem = { ch: string } | { repeat: string; count: number };

/** Decode a backslash escape at s[i] === '\\'. Returns [char, nextIndex]. */
function readEscape(s: string, i: number): [string, number] {
  const n = s[i + 1];
  if (n === undefined) return ['\\', i + 1];
  if (n >= '0' && n <= '7') {
    let j = i + 1;
    let oct = '';
    while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
    return [String.fromCharCode(parseInt(oct, 8) & 0xff), j];
  }
  const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\' };
  return [map[n] ?? n, i + 2];
}

/** Expand a tr SET (escapes, ranges, [:class:], [=c=], [c*n]) into elements. */
function parseSet(s: string): Elem[] {
  const out: Elem[] = [];
  // First pass: single chars, with escapes resolved, plus bracket constructs.
  type Tok = { ch: string; literal: boolean } | { chars: string } | { repeat: string; count: number };
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '[' && s[i + 1] === ':') {
      const close = s.indexOf(':]', i + 2);
      if (close !== -1) {
        const name = s.slice(i + 2, close);
        const chars = classChars(name);
        if (chars === null) throw new TrError(`invalid character class '${name}'`);
        toks.push({ chars });
        i = close + 2;
        continue;
      }
    }
    if (s[i] === '[' && s[i + 1] === '=') {
      const close = s.indexOf('=]', i + 2);
      if (close !== -1) {
        let body = s.slice(i + 2, close);
        if (body.startsWith('\\')) body = readEscape(body, 0)[0];
        toks.push({ chars: body });
        i = close + 2;
        continue;
      }
    }
    if (s[i] === '[' && i + 2 < s.length) {
      // [c*] or [c*n]
      let j = i + 1;
      let c: string;
      if (s[j] === '\\') { [c, j] = readEscape(s, j); } else { c = s[j]; j++; }
      if (s[j] === '*') {
        const close = s.indexOf(']', j + 1);
        const num = close === -1 ? null : s.slice(j + 1, close);
        if (num !== null && /^[0-9]*$/.test(num)) {
          const count = num === '' ? 0 : num.startsWith('0') ? parseInt(num, 8) : parseInt(num, 10);
          toks.push({ repeat: c, count });
          i = close + 1;
          continue;
        }
      }
    }
    if (s[i] === '\\') {
      const [c, j] = readEscape(s, i);
      toks.push({ ch: c, literal: true });
      i = j;
      continue;
    }
    toks.push({ ch: s[i], literal: false });
    i++;
  }
  // Second pass: ranges `a-z` between two single chars.
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if ('chars' in t) { for (const c of t.chars) out.push({ ch: c }); continue; }
    if ('repeat' in t) { out.push(t); continue; }
    const dash = toks[k + 1];
    const end = toks[k + 2];
    if (dash && 'ch' in dash && dash.ch === '-' && !dash.literal && end && 'ch' in end) {
      const a = t.ch.charCodeAt(0);
      const b = end.ch.charCodeAt(0);
      if (b < a) throw new TrError(`range-endpoints of '${t.ch}-${end.ch}' are in reverse collating sequence order`);
      for (let c = a; c <= b; c++) out.push({ ch: String.fromCharCode(c) });
      k += 2;
      continue;
    }
    out.push({ ch: t.ch });
  }
  return out;
}

/** Flatten elements to a char list; `[c*]` / `[c*0]` fills up to `fillTo`. */
function flatten(elems: Elem[], fillTo = 0): string[] {
  const fixed = elems.reduce((n, e) => n + ('ch' in e ? 1 : e.count), 0);
  const chars: string[] = [];
  let filled = false;
  for (const e of elems) {
    if ('ch' in e) { chars.push(e.ch); continue; }
    let n = e.count;
    if (n === 0 && !filled) { n = Math.max(0, fillTo - fixed); filled = true; }
    for (let k = 0; k < n; k++) chars.push(e.repeat);
  }
  return chars;
}

const command: Command = async (ctx) => {
  let complement = false;
  let deleteMode = false;
  let squeeze = false;
  let truncate = false;
  const sets: string[] = [];
  let optsDone = false;

  for (const arg of ctx.args) {
    if (!optsDone && arg === '--') { optsDone = true; continue; }
    if (!optsDone && arg.startsWith('--') && arg.length > 2) {
      if (arg === '--complement') complement = true;
      else if (arg === '--delete') deleteMode = true;
      else if (arg === '--squeeze-repeats') squeeze = true;
      else if (arg === '--truncate-set1') truncate = true;
      else { ctx.stderr.write(`tr: unrecognized option '${arg}'\n`); return 1; }
      continue;
    }
    if (!optsDone && arg.length > 1 && arg[0] === '-' && /^-[cCdst]+$/.test(arg)) {
      for (const f of arg.slice(1)) {
        if (f === 'c' || f === 'C') complement = true;
        else if (f === 'd') deleteMode = true;
        else if (f === 's') squeeze = true;
        else if (f === 't') truncate = true;
      }
      continue;
    }
    sets.push(arg);
  }

  if (sets.length === 0) {
    ctx.stderr.write('tr: missing operand\n');
    return 1;
  }
  const translating = !deleteMode && sets.length >= 2;
  if (deleteMode && !squeeze && sets.length > 1) {
    ctx.stderr.write(`tr: extra operand '${sets[1]}'\nOnly one string may be given when deleting without squeezing repeats.\n`);
    return 1;
  }
  if ((deleteMode && squeeze && sets.length < 2) || (!deleteMode && !squeeze && sets.length < 2)) {
    ctx.stderr.write(`tr: missing operand after '${sets[0]}'\n`);
    return 1;
  }

  if (!ctx.stdin) {
    ctx.stderr.write('tr: missing input\n');
    return 1;
  }

  let set1: string[];
  let set2: string[] = [];
  try {
    set1 = flatten(parseSet(sets[0]));
    if (sets.length >= 2) {
      const raw2 = parseSet(sets[1]);
      // In SET2 `[c*]` fills to SET1's length.
      const len1 = complement ? 256 - new Set(set1.filter((c) => c.charCodeAt(0) < 256)).size : set1.length;
      set2 = flatten(raw2, len1);
    }
  } catch (e) {
    if (e instanceof TrError) { ctx.stderr.write(`tr: ${e.message}\n`); return 1; }
    throw e;
  }

  const set1Members = new Set(set1);
  const inSet1 = (c: string) => (complement ? !set1Members.has(c) : set1Members.has(c));

  // Translation table.
  const map = new Map<string, string>();
  let complementDefault: string | undefined;
  if (translating) {
    if (set2.length === 0) {
      ctx.stderr.write('tr: when not truncating set1, string2 must be non-empty\n');
      return 1;
    }
    let from: string[] = set1;
    if (complement) {
      from = [];
      for (let c = 0; c < 256; c++) {
        const ch = String.fromCharCode(c);
        if (!set1Members.has(ch)) from.push(ch);
      }
      // Code points above 0xff are also outside SET1: they map like the
      // padding, to SET2's last char.
      complementDefault = set2[set2.length - 1];
    }
    if (truncate) from = from.slice(0, set2.length);
    for (let k = 0; k < from.length; k++) {
      map.set(from[k], set2[Math.min(k, set2.length - 1)]);
    }
  }

  const text = await ctx.stdin.readAll();
  // Squeeze applies to SET2 when translating or deleting, else SET1.
  const squeezeSet = new Set(translating || deleteMode ? set2 : []);
  const inSqueeze = (c: string) => (translating || deleteMode ? squeezeSet.has(c) : inSet1(c));

  let result = '';
  let last: string | undefined;
  for (const ch of text) {
    let c = ch;
    if (deleteMode) {
      if (inSet1(c)) continue;
    } else if (translating) {
      const m = map.get(c);
      if (m !== undefined) c = m;
      else if (complementDefault !== undefined && c.codePointAt(0)! > 0xff && !set1Members.has(c)) c = complementDefault;
    }
    if (squeeze && c === last && inSqueeze(c)) continue;
    result += c;
    last = c;
  }

  ctx.stdout.write(result);
  return 0;
};

export default command;
