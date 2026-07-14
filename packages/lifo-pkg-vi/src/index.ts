import type { Command, CommandContext } from '@lifo-sh/core';
import { resolve, VFSError } from '@lifo-sh/core';

/**
 * vi — a modal text editor (a usable subset of vi/vim), built on the same
 * full-screen infrastructure as nano/less: raw-mode input, a viewport with
 * vertical/horizontal scroll, and a render loop.
 *
 * Modes: normal (default), insert, command-line (`:`), search (`/`).
 * Supported: h/j/k/l + arrows, w/b/e, 0/^/$, gg/G, Ctrl-D/U, PageUp/Down;
 * i/a/I/A/o/O; x/X, dd/dw/D, cc/cw/C, r, s; yy/p/P; u/Ctrl-R; /,n,N;
 * count prefixes (e.g. 3dd, 5j); :w [file], :q, :q!, :wq/:x.
 */

// ─── ANSI escape helpers ───
const CSI = '\x1b[';
const CLEAR = `${CSI}2J`;
const HOME = `${CSI}H`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ERASE_LINE = `${CSI}2K`;

function moveTo(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

// ─── Key parsing ───
type KeyType =
  | 'char' | 'enter' | 'backspace' | 'delete' | 'tab'
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'ctrl-d' | 'ctrl-u' | 'ctrl-r' | 'ctrl-c' | 'escape' | 'unknown';

interface KeyEvent { type: KeyType; char?: string }

function parseKey(data: string): KeyEvent {
  if (data === '\r' || data === '\n') return { type: 'enter' };
  if (data === '\x7f' || data === '\b') return { type: 'backspace' };
  if (data === '\t') return { type: 'tab' };
  if (data === '\x04') return { type: 'ctrl-d' };
  if (data === '\x15') return { type: 'ctrl-u' };
  if (data === '\x12') return { type: 'ctrl-r' };
  if (data === '\x03') return { type: 'ctrl-c' };
  if (data === '\x1b') return { type: 'escape' };

  if (data.startsWith('\x1b[')) {
    const seq = data.slice(2);
    if (seq === 'A') return { type: 'up' };
    if (seq === 'B') return { type: 'down' };
    if (seq === 'C') return { type: 'right' };
    if (seq === 'D') return { type: 'left' };
    if (seq === 'H' || seq === '1~' || seq === '7~') return { type: 'home' };
    if (seq === 'F' || seq === '4~' || seq === '8~') return { type: 'end' };
    if (seq === '3~') return { type: 'delete' };
    if (seq === '5~') return { type: 'pageup' };
    if (seq === '6~') return { type: 'pagedown' };
    return { type: 'unknown' };
  }

  if (data.length >= 1 && data.charCodeAt(0) >= 32) return { type: 'char', char: data };
  return { type: 'unknown' };
}

// ─── State ───
type Mode = 'normal' | 'insert' | 'command' | 'search';

interface Register { lines: string[]; linewise: boolean }
interface Snapshot { lines: string[]; cursorRow: number; cursorCol: number }

interface State {
  lines: string[];
  modified: boolean;
  filePath: string;
  isNewFile: boolean;

  cursorRow: number;
  cursorCol: number;
  preferredCol: number;

  scrollRow: number;
  scrollCol: number;
  rows: number;
  cols: number;

  mode: Mode;
  /** pending operator/prefix in normal mode: 'd' | 'c' | 'y' | 'g' | 'r' */
  pending: string | null;
  /** accumulating numeric count (e.g. "12" for 12dd) */
  count: string;
  promptBuf: string;

  register: Register;
  undo: Snapshot[];
  redo: Snapshot[];

  lastSearch: string;
  statusMsg: string;
}

// ─── File I/O ───
function loadFile(ctx: CommandContext, path: string): { lines: string[]; isNew: boolean } {
  try {
    const content = new TextDecoder().decode(ctx.vfs.readFile(path));
    const lines = content.split('\n');
    // A trailing newline yields a final '' element; drop it for editing.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.length ? lines : [''], isNew: false };
  } catch (e) {
    if (e instanceof VFSError && e.code === 'ENOENT') return { lines: [''], isNew: true };
    throw e;
  }
}

function saveFile(ctx: CommandContext, path: string, lines: string[]): number {
  const content = lines.join('\n') + '\n';
  ctx.vfs.writeFile(path, content);
  return content.length;
}

// ─── Undo ───
function snapshot(s: State): Snapshot {
  return { lines: s.lines.slice(), cursorRow: s.cursorRow, cursorCol: s.cursorCol };
}
function pushUndo(s: State): void {
  s.undo.push(snapshot(s));
  if (s.undo.length > 200) s.undo.shift();
  s.redo = [];
}
function restore(s: State, snap: Snapshot): void {
  s.lines = snap.lines.slice();
  s.cursorRow = Math.min(snap.cursorRow, s.lines.length - 1);
  s.cursorCol = snap.cursorCol;
  clampCursor(s, false);
}

// ─── Cursor / motions ───
function curLine(s: State): string { return s.lines[s.cursorRow] ?? ''; }

/** Clamp the cursor within the buffer. In normal mode the cursor rests ON a
 *  char (max col = len-1); in insert it may sit after the last char (col=len). */
function clampCursor(s: State, insert: boolean): void {
  if (s.cursorRow < 0) s.cursorRow = 0;
  if (s.cursorRow > s.lines.length - 1) s.cursorRow = s.lines.length - 1;
  const len = curLine(s).length;
  const max = insert ? len : Math.max(0, len - 1);
  if (s.cursorCol > max) s.cursorCol = max;
  if (s.cursorCol < 0) s.cursorCol = 0;
}

const isWord = (c: string): boolean => /\w/.test(c);

function wordForward(s: State): void {
  let { cursorRow: r, cursorCol: c } = s;
  const line = () => s.lines[r] ?? '';
  const cls = (ch: string) => (ch === undefined || ch === '' ? 0 : /\s/.test(ch) ? 1 : isWord(ch) ? 2 : 3);
  const start = cls(line()[c]);
  // skip the current run
  while (c < line().length && cls(line()[c]) === start && start !== 1) c++;
  // skip whitespace (possibly across lines)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (c >= line().length) {
      if (r < s.lines.length - 1) { r++; c = 0; } else break;
    }
    if (cls(line()[c]) === 1) c++;
    else break;
  }
  s.cursorRow = r; s.cursorCol = c;
}

function wordBackward(s: State): void {
  let { cursorRow: r, cursorCol: c } = s;
  const line = () => s.lines[r] ?? '';
  const nonspace = (ch: string) => ch !== undefined && !/\s/.test(ch);
  c--;
  while (r > 0 || c >= 0) {
    if (c < 0) { if (r === 0) { c = 0; break; } r--; c = line().length - 1; continue; }
    if (nonspace(line()[c])) break;
    c--;
  }
  // move to the start of this word
  const cls = (ch: string) => (isWord(ch) ? 2 : 3);
  if (c >= 0 && nonspace(line()[c])) {
    const k = cls(line()[c]);
    while (c > 0 && nonspace(line()[c - 1]) && cls(line()[c - 1]) === k) c--;
  }
  s.cursorRow = r; s.cursorCol = Math.max(0, c);
}

function wordEnd(s: State): void {
  let { cursorRow: r, cursorCol: c } = s;
  const line = () => s.lines[r] ?? '';
  c++;
  while (r < s.lines.length) {
    if (c >= line().length) { if (r === s.lines.length - 1) { c = line().length - 1; break; } r++; c = 0; continue; }
    if (/\s/.test(line()[c])) { c++; continue; }
    break;
  }
  const nonspace = (ch: string) => ch !== undefined && !/\s/.test(ch);
  const cls = (ch: string) => (isWord(ch) ? 2 : 3);
  if (c < line().length && nonspace(line()[c])) {
    const k = cls(line()[c]);
    while (c < line().length - 1 && nonspace(line()[c + 1]) && cls(line()[c + 1]) === k) c++;
  }
  s.cursorRow = r; s.cursorCol = Math.max(0, c);
}

function firstNonBlank(line: string): number {
  const m = line.match(/\S/);
  return m ? m.index! : 0;
}

// ─── Rendering ───
function ensureVisible(s: State): void {
  const contentH = s.rows - 1; // one status line
  if (s.cursorRow < s.scrollRow) s.scrollRow = s.cursorRow;
  if (s.cursorRow >= s.scrollRow + contentH) s.scrollRow = s.cursorRow - contentH + 1;
  if (s.cursorCol < s.scrollCol) s.scrollCol = s.cursorCol;
  if (s.cursorCol >= s.scrollCol + s.cols) s.scrollCol = s.cursorCol - s.cols + 1;
}

function render(s: State, out: { write(t: string): void }): void {
  const contentH = s.rows - 1;
  let buf = HIDE_CURSOR;

  for (let i = 0; i < contentH; i++) {
    const docRow = s.scrollRow + i;
    buf += moveTo(i, 0) + ERASE_LINE;
    if (docRow < s.lines.length) {
      buf += s.lines[docRow].slice(s.scrollCol, s.scrollCol + s.cols);
    } else {
      buf += '~'; // vi's empty-line marker
    }
  }

  // Status / command line
  buf += moveTo(s.rows - 1, 0) + ERASE_LINE;
  if (s.mode === 'command') {
    buf += ':' + s.promptBuf;
  } else if (s.mode === 'search') {
    buf += '/' + s.promptBuf;
  } else {
    const left = s.mode === 'insert' ? '-- INSERT --' : (s.statusMsg || '');
    const name = s.filePath.split('/').pop() || '[No Name]';
    const right = `${name}${s.modified ? ' [+]' : ''}  ${s.cursorRow + 1},${s.cursorCol + 1}`;
    const gap = Math.max(1, s.cols - left.length - right.length);
    buf += left + ' '.repeat(gap) + right;
  }

  // Position the real cursor
  if (s.mode === 'command' || s.mode === 'search') {
    buf += moveTo(s.rows - 1, s.promptBuf.length + 1);
  } else {
    buf += moveTo(s.cursorRow - s.scrollRow, s.cursorCol - s.scrollCol);
  }
  buf += SHOW_CURSOR;
  out.write(buf);
}

// ─── Edits (all snapshot for undo before mutating) ───
function deleteCharUnder(s: State): void {
  const line = curLine(s);
  if (!line.length) return;
  pushUndo(s);
  s.register = { lines: [line[s.cursorCol] ?? ''], linewise: false };
  s.lines[s.cursorRow] = line.slice(0, s.cursorCol) + line.slice(s.cursorCol + 1);
  s.modified = true;
  clampCursor(s, false);
}

function deleteLines(s: State, n: number): void {
  pushUndo(s);
  const end = Math.min(s.lines.length, s.cursorRow + n);
  s.register = { lines: s.lines.slice(s.cursorRow, end), linewise: true };
  s.lines.splice(s.cursorRow, end - s.cursorRow);
  if (s.lines.length === 0) s.lines = [''];
  if (s.cursorRow > s.lines.length - 1) s.cursorRow = s.lines.length - 1;
  s.cursorCol = firstNonBlank(curLine(s));
  s.modified = true;
}

function deleteToEol(s: State): void {
  const line = curLine(s);
  pushUndo(s);
  s.register = { lines: [line.slice(s.cursorCol)], linewise: false };
  s.lines[s.cursorRow] = line.slice(0, s.cursorCol);
  s.modified = true;
  clampCursor(s, false);
}

/** Delete from the cursor over a motion's range (dw, de, d$, db, …). */
function deleteToMotion(s: State, motion: (st: State) => void): void {
  const r0 = s.cursorRow, c0 = s.cursorCol;
  motion(s);
  const r1 = s.cursorRow, c1 = s.cursorCol;
  s.cursorRow = r0;
  pushUndo(s);
  const line = s.lines[r0];
  if (r1 === r0) {
    const from = Math.min(c0, c1), to = Math.max(c0, c1);
    s.register = { lines: [line.slice(from, to)], linewise: false };
    s.lines[r0] = line.slice(0, from) + line.slice(to);
    s.cursorCol = from;
  } else {
    // Multi-line motion (e.g. `w` across a line end): delete to end of this line.
    s.register = { lines: [line.slice(c0)], linewise: false };
    s.lines[r0] = line.slice(0, c0);
    s.cursorCol = c0;
  }
  s.modified = true;
  clampCursor(s, false);
}

function paste(s: State, after: boolean): void {
  if (!s.register.lines.length) return;
  pushUndo(s);
  if (s.register.linewise) {
    const at = after ? s.cursorRow + 1 : s.cursorRow;
    s.lines.splice(at, 0, ...s.register.lines);
    s.cursorRow = at;
    s.cursorCol = firstNonBlank(curLine(s));
  } else {
    const line = curLine(s);
    const text = s.register.lines.join('\n');
    const at = after ? Math.min(line.length, s.cursorCol + 1) : s.cursorCol;
    s.lines[s.cursorRow] = line.slice(0, at) + text + line.slice(at);
    s.cursorCol = at + text.length - 1;
  }
  s.modified = true;
}

function yankLines(s: State, n: number): void {
  const end = Math.min(s.lines.length, s.cursorRow + n);
  s.register = { lines: s.lines.slice(s.cursorRow, end), linewise: true };
  s.statusMsg = `${end - s.cursorRow} line(s) yanked`;
}

function openLine(s: State, below: boolean): void {
  pushUndo(s);
  const at = below ? s.cursorRow + 1 : s.cursorRow;
  s.lines.splice(at, 0, '');
  s.cursorRow = at;
  s.cursorCol = 0;
  s.mode = 'insert';
  s.modified = true;
}

// ─── Insert-mode edits ───
function insertText(s: State, ch: string): void {
  const line = curLine(s);
  s.lines[s.cursorRow] = line.slice(0, s.cursorCol) + ch + line.slice(s.cursorCol);
  s.cursorCol += ch.length;
  s.modified = true;
}
function insertNewline(s: State): void {
  const line = curLine(s);
  const rest = line.slice(s.cursorCol);
  s.lines[s.cursorRow] = line.slice(0, s.cursorCol);
  s.lines.splice(s.cursorRow + 1, 0, rest);
  s.cursorRow++;
  s.cursorCol = 0;
  s.modified = true;
}
function insertBackspace(s: State): void {
  if (s.cursorCol > 0) {
    const line = curLine(s);
    s.lines[s.cursorRow] = line.slice(0, s.cursorCol - 1) + line.slice(s.cursorCol);
    s.cursorCol--;
  } else if (s.cursorRow > 0) {
    const prev = s.lines[s.cursorRow - 1];
    s.cursorCol = prev.length;
    s.lines[s.cursorRow - 1] = prev + curLine(s);
    s.lines.splice(s.cursorRow, 1);
    s.cursorRow--;
  }
  s.modified = true;
}

// ─── Search ───
function doSearch(s: State, pattern: string, forward = true): boolean {
  if (!pattern) return false;
  s.lastSearch = pattern;
  const n = s.lines.length;
  for (let i = 1; i <= n; i++) {
    const r = ((s.cursorRow + (forward ? i : -i)) % n + n) % n;
    const from = r === s.cursorRow ? -1 : 0;
    const idx = forward
      ? s.lines[r].indexOf(pattern, r === s.cursorRow ? s.cursorCol + 1 : 0)
      : s.lines[r].lastIndexOf(pattern);
    void from;
    if (idx >= 0) { s.cursorRow = r; s.cursorCol = idx; return true; }
  }
  s.statusMsg = `E486: Pattern not found: ${pattern}`;
  return false;
}

// ─── Normal-mode key handling ───
function handleNormalKey(s: State, key: KeyEvent): void {
  s.statusMsg = '';
  const rep = Math.max(1, parseInt(s.count || '1', 10));

  // Pending r<char>: replace one char
  if (s.pending === 'r') {
    s.pending = null; s.count = '';
    if (key.type === 'char' && key.char) {
      const line = curLine(s);
      if (line.length) { pushUndo(s); s.lines[s.cursorRow] = line.slice(0, s.cursorCol) + key.char + line.slice(s.cursorCol + 1); s.modified = true; }
    }
    return;
  }

  if (key.type !== 'char') {
    // Arrows / nav keys work in normal mode too.
    s.pending = null; s.count = '';
    switch (key.type) {
      case 'left': s.cursorCol -= rep; break;
      case 'right': s.cursorCol += rep; break;
      case 'up': s.cursorRow -= rep; s.cursorCol = Math.min(s.preferredCol, Math.max(0, curLine(s).length - 1)); break;
      case 'down': s.cursorRow += rep; s.cursorCol = Math.min(s.preferredCol, Math.max(0, curLine(s).length - 1)); break;
      case 'home': s.cursorCol = 0; break;
      case 'end': s.cursorCol = Math.max(0, curLine(s).length - 1); break;
      case 'pageup': case 'ctrl-u': s.cursorRow -= Math.floor(s.rows / 2); break;
      case 'pagedown': case 'ctrl-d': s.cursorRow += Math.floor(s.rows / 2); break;
      case 'delete': deleteCharUnder(s); break;
      case 'backspace': s.cursorCol -= 1; break;
      case 'enter': s.cursorRow += 1; s.cursorCol = firstNonBlank(curLine(s)); break;
    }
    clampCursor(s, false);
    s.preferredCol = s.cursorCol;
    return;
  }

  const c = key.char!;

  // Count prefix (0 is a motion unless a count is being built)
  if (/[0-9]/.test(c) && !(c === '0' && !s.count)) { s.count += c; return; }

  // Pending operator (d/c/y) or g
  if (s.pending) {
    const op = s.pending;
    s.pending = null;
    const n = rep;
    s.count = '';
    if (op === 'g') { if (c === 'g') { s.cursorRow = 0; s.cursorCol = firstNonBlank(curLine(s)); } return; }
    // operators: dd/cc/yy (doubled) operate on lines
    if ((op === 'd' && c === 'd') || (op === 'c' && c === 'c') || (op === 'y' && c === 'y')) {
      if (op === 'y') yankLines(s, n);
      else { deleteLines(s, n); if (op === 'c') { openLine(s, false); /* cc → open a line to type on */ } }
      return;
    }
    // operator + motion (dw, cw, de, d$, etc.)
    const motion = motionFor(c);
    if (motion) {
      if (op === 'y') { /* charwise yank omitted for brevity */ return; }
      for (let i = 0; i < n; i++) deleteToMotion(s, motion);
      if (op === 'c') s.mode = 'insert';
    }
    return;
  }

  s.count = '';
  switch (c) {
    // motions
    case 'h': s.cursorCol -= rep; break;
    case 'l': case ' ': s.cursorCol += rep; break;
    case 'k': s.cursorRow -= rep; s.cursorCol = Math.min(s.preferredCol, Math.max(0, curLine(s).length - 1)); break;
    case 'j': s.cursorRow += rep; s.cursorCol = Math.min(s.preferredCol, Math.max(0, curLine(s).length - 1)); break;
    case 'w': for (let i = 0; i < rep; i++) wordForward(s); break;
    case 'b': for (let i = 0; i < rep; i++) wordBackward(s); break;
    case 'e': for (let i = 0; i < rep; i++) wordEnd(s); break;
    case '0': s.cursorCol = 0; break;
    case '^': s.cursorCol = firstNonBlank(curLine(s)); break;
    case '$': s.cursorCol = Math.max(0, curLine(s).length - 1); break;
    case 'G': s.cursorRow = (s.count === '' && rep === 1) ? s.lines.length - 1 : Math.min(s.lines.length - 1, rep - 1); s.cursorCol = firstNonBlank(curLine(s)); break;
    case 'g': s.pending = 'g'; return;
    // enter insert
    case 'i': pushUndo(s); s.mode = 'insert'; break;
    case 'a': pushUndo(s); s.mode = 'insert'; s.cursorCol = Math.min(curLine(s).length, s.cursorCol + 1); break;
    case 'I': pushUndo(s); s.mode = 'insert'; s.cursorCol = firstNonBlank(curLine(s)); break;
    case 'A': pushUndo(s); s.mode = 'insert'; s.cursorCol = curLine(s).length; break;
    case 'o': openLine(s, true); break;
    case 'O': openLine(s, false); break;
    // edits
    case 'x': for (let i = 0; i < rep; i++) deleteCharUnder(s); break;
    case 'X': for (let i = 0; i < rep; i++) { if (s.cursorCol > 0) { s.cursorCol--; deleteCharUnder(s); } } break;
    case 's': deleteCharUnder(s); s.mode = 'insert'; break;
    case 'D': deleteToEol(s); break;
    case 'C': deleteToEol(s); s.mode = 'insert'; s.cursorCol = curLine(s).length; break;
    case 'd': s.pending = 'd'; s.count = String(rep === 1 ? '' : rep); return;
    case 'c': s.pending = 'c'; s.count = String(rep === 1 ? '' : rep); return;
    case 'y': s.pending = 'y'; s.count = String(rep === 1 ? '' : rep); return;
    case 'r': s.pending = 'r'; return;
    case 'p': for (let i = 0; i < rep; i++) paste(s, true); break;
    case 'P': for (let i = 0; i < rep; i++) paste(s, false); break;
    case 'u': for (let i = 0; i < rep; i++) { const snap = s.undo.pop(); if (snap) { s.redo.push(snapshot(s)); restore(s, snap); s.modified = true; } else s.statusMsg = 'Already at oldest change'; } break;
    case 'n': doSearch(s, s.lastSearch, true); break;
    case 'N': doSearch(s, s.lastSearch, false); break;
    case '/': s.mode = 'search'; s.promptBuf = ''; return;
    case ':': s.mode = 'command'; s.promptBuf = ''; return;
    default: break;
  }
  // Clamp per the resulting mode (i/a/A/o… switch to insert, where the cursor
  // may rest after the last char).
  clampCursor(s, s.mode === 'insert');
  s.preferredCol = s.cursorCol;
}

function motionFor(c: string): ((s: State) => void) | null {
  switch (c) {
    case 'w': return wordForward;
    case 'e': return (s) => { wordEnd(s); s.cursorCol++; }; // dw/de are exclusive-ish; include the end char
    case 'b': return wordBackward;
    case '$': return (s) => { s.cursorCol = curLine(s).length; };
    case '0': return (s) => { s.cursorCol = 0; };
    default: return null;
  }
}

// ─── Insert-mode key handling ───
function handleInsertKey(s: State, key: KeyEvent): void {
  switch (key.type) {
    case 'escape': s.mode = 'normal'; s.cursorCol = Math.max(0, s.cursorCol - 1); clampCursor(s, false); break;
    case 'enter': insertNewline(s); break;
    case 'backspace': insertBackspace(s); break;
    case 'delete': deleteCharUnder(s); break;
    case 'tab': insertText(s, '  '); break;
    case 'left': s.cursorCol = Math.max(0, s.cursorCol - 1); break;
    case 'right': s.cursorCol = Math.min(curLine(s).length, s.cursorCol + 1); break;
    case 'up': s.cursorRow = Math.max(0, s.cursorRow - 1); clampCursor(s, true); break;
    case 'down': s.cursorRow = Math.min(s.lines.length - 1, s.cursorRow + 1); clampCursor(s, true); break;
    case 'home': s.cursorCol = 0; break;
    case 'end': s.cursorCol = curLine(s).length; break;
    case 'char': if (key.char) insertText(s, key.char); break;
    default: break;
  }
  s.preferredCol = s.cursorCol;
}

// ─── Command-line (`:`) handling → returns true to quit ───
function runExCommand(s: State, ctx: CommandContext): boolean | 'quit' {
  const cmd = s.promptBuf.trim();
  s.mode = 'normal';
  s.promptBuf = '';
  // Longest verbs first — ordered alternation would match `w` inside `wq`.
  const m = cmd.match(/^(wq!|wq|w!|q!|x|w|q)\s*(.*)$/);
  if (!m) {
    if (/^\d+$/.test(cmd)) { s.cursorRow = Math.min(s.lines.length - 1, parseInt(cmd, 10) - 1); s.cursorCol = firstNonBlank(curLine(s)); return false; }
    s.statusMsg = `E492: Not an editor command: ${cmd}`;
    return false;
  }
  const [, verb, arg] = m;
  const write = () => {
    const path = arg ? resolve(ctx.cwd, arg) : s.filePath;
    const bytes = saveFile(ctx, path, s.lines);
    s.filePath = path;
    s.modified = false;
    s.statusMsg = `"${path.split('/').pop()}" ${s.lines.length}L, ${bytes}B written`;
  };
  try {
    if (verb === 'w' || verb === 'w!') { write(); return false; }
    if (verb === 'q') { if (s.modified) { s.statusMsg = 'E37: No write since last change (add ! to override)'; return false; } return 'quit'; }
    if (verb === 'q!') return 'quit';
    if (verb === 'wq' || verb === 'x' || verb === 'wq!') { write(); return 'quit'; }
  } catch (e) {
    s.statusMsg = `E212: Can't open file for writing: ${e instanceof Error ? e.message : String(e)}`;
  }
  return false;
}

// ─── Command entry ───
const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    ctx.stderr.write('Usage: vi <filename>\n');
    return 1;
  }
  const filePath = resolve(ctx.cwd, ctx.args[0]);
  const rows = parseInt(ctx.env['LINES'] || '24', 10);
  const cols = parseInt(ctx.env['COLUMNS'] || '80', 10);

  ctx.setRawMode?.(true);
  try {
    const { lines, isNew } = loadFile(ctx, filePath);
    const s: State = {
      lines, modified: false, filePath, isNewFile: isNew,
      cursorRow: 0, cursorCol: 0, preferredCol: 0,
      scrollRow: 0, scrollCol: 0, rows, cols,
      mode: 'normal', pending: null, count: '', promptBuf: '',
      register: { lines: [], linewise: false }, undo: [], redo: [],
      lastSearch: '', statusMsg: isNew ? `"${filePath.split('/').pop()}" [New]` : `"${filePath.split('/').pop()}" ${lines.length}L`,
    };

    ctx.stdout.write(CLEAR + HOME);
    render(s, ctx.stdout);

    let quit = false;
    while (!quit) {
      const data = await ctx.stdin?.read();
      if (data === null || data === undefined) break;

      // A single keypress / escape sequence, or pasted text.
      const isSingle = data.startsWith('\x1b') || data.length === 1;
      if (isSingle) {
        const key = parseKey(data);
        if (s.mode === 'normal') {
          if (key.type === 'ctrl-c') { s.statusMsg = 'Type :q! and press Enter to quit'; }
          else if (key.type === 'ctrl-r') { const snap = s.redo.pop(); if (snap) { s.undo.push(snapshot(s)); restore(s, snap); } }
          else handleNormalKey(s, key);
        } else if (s.mode === 'insert') {
          handleInsertKey(s, key);
        } else if (s.mode === 'command' || s.mode === 'search') {
          if (key.type === 'escape') { s.mode = 'normal'; s.promptBuf = ''; }
          else if (key.type === 'backspace') { if (s.promptBuf) s.promptBuf = s.promptBuf.slice(0, -1); else s.mode = 'normal'; }
          else if (key.type === 'enter') {
            if (s.mode === 'command') { const r = runExCommand(s, ctx); if (r === 'quit') quit = true; }
            else { const p = s.promptBuf; s.mode = 'normal'; s.promptBuf = ''; doSearch(s, p, true); }
          } else if (key.type === 'char' && key.char) { s.promptBuf += key.char; }
        }
      } else if (s.mode === 'insert') {
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') insertNewline(s);
          else if (ch.charCodeAt(0) >= 32) insertText(s, ch);
        }
      }

      if (quit) break;
      ensureVisible(s);
      render(s, ctx.stdout);
    }

    ctx.stdout.write(CLEAR + HOME + SHOW_CURSOR);
  } finally {
    ctx.setRawMode?.(false);
  }
  return 0;
};

export default command;
