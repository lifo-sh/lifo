import type { Command, CommandContext, CommandOutputStream } from '@lifo-sh/core';
import { resolve, VFSError } from '@lifo-sh/core';

// ─── ANSI escape helpers ───

const CSI = '\x1b[';
const CLEAR = `${CSI}2J`;
const HOME = `${CSI}H`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ERASE_LINE = `${CSI}2K`;
const INVERT = `${CSI}7m`;
const BOLD = `${CSI}1m`;
const RST = `${CSI}0m`;

function moveTo(row: number, col: number): string {
  return `${CSI}${row + 1};${col + 1}H`;
}

// ─── Key parsing ───

type KeyType =
  | 'char' | 'enter' | 'backspace' | 'delete' | 'tab'
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'ctrl-o' | 'ctrl-x' | 'ctrl-k' | 'ctrl-u' | 'ctrl-w'
  | 'ctrl-c' | 'escape' | 'unknown';

interface KeyEvent {
  type: KeyType;
  char?: string;
}

function parseKey(data: string): KeyEvent {
  if (data === '\r') return { type: 'enter' };
  if (data === '\x7f' || data === '\b') return { type: 'backspace' };
  if (data === '\t') return { type: 'tab' };
  if (data === '\x0f') return { type: 'ctrl-o' };
  if (data === '\x18') return { type: 'ctrl-x' };
  if (data === '\x0b') return { type: 'ctrl-k' };
  if (data === '\x15') return { type: 'ctrl-u' };
  if (data === '\x17') return { type: 'ctrl-w' };
  if (data === '\x03') return { type: 'ctrl-c' };
  if (data === '\x1b' && data.length === 1) return { type: 'escape' };

  if (data.startsWith('\x1b[')) {
    const seq = data.slice(2);
    if (seq === 'A') return { type: 'up' };
    if (seq === 'B') return { type: 'down' };
    if (seq === 'C') return { type: 'right' };
    if (seq === 'D') return { type: 'left' };
    if (seq === 'H') return { type: 'home' };
    if (seq === 'F') return { type: 'end' };
    if (seq === '1~' || seq === '7~') return { type: 'home' };
    if (seq === '4~' || seq === '8~') return { type: 'end' };
    if (seq === '3~') return { type: 'delete' };
    if (seq === '5~') return { type: 'pageup' };
    if (seq === '6~') return { type: 'pagedown' };
    return { type: 'unknown' };
  }

  if (data.length >= 1 && data.charCodeAt(0) >= 32) {
    return { type: 'char', char: data };
  }

  return { type: 'unknown' };
}

// ─── Editor state ───

type Mode = 'edit' | 'save-prompt' | 'search-prompt' | 'dirty-exit';

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
  promptBuf: string;

  statusMsg: string;
  statusExpiry: number;

  cutBuffer: string[];
}

// ─── File I/O ───

function loadFile(ctx: CommandContext, path: string): { lines: string[]; isNew: boolean } {
  try {
    const content = ctx.vfs.readFileString(path);
    const lines = content.split('\n');
    // Files that end with \n produce a trailing empty string from split
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return { lines: lines.length === 0 ? [''] : lines, isNew: false };
  } catch (e) {
    if (e instanceof VFSError && e.message.includes('ENOENT')) {
      return { lines: [''], isNew: true };
    }
    throw e;
  }
}

function saveFile(ctx: CommandContext, path: string, lines: string[]): void {
  ctx.vfs.writeFile(path, lines.join('\n') + '\n');
}

// ─── Text editing ───

function insertChar(s: State, ch: string): void {
  const line = s.lines[s.cursorRow];
  s.lines[s.cursorRow] = line.slice(0, s.cursorCol) + ch + line.slice(s.cursorCol);
  s.cursorCol += ch.length;
  s.preferredCol = s.cursorCol;
  s.modified = true;
}

function insertNewline(s: State): void {
  const line = s.lines[s.cursorRow];
  s.lines[s.cursorRow] = line.slice(0, s.cursorCol);
  s.lines.splice(s.cursorRow + 1, 0, line.slice(s.cursorCol));
  s.cursorRow++;
  s.cursorCol = 0;
  s.preferredCol = 0;
  s.modified = true;
}

function deleteBackward(s: State): void {
  if (s.cursorCol > 0) {
    const line = s.lines[s.cursorRow];
    s.lines[s.cursorRow] = line.slice(0, s.cursorCol - 1) + line.slice(s.cursorCol);
    s.cursorCol--;
  } else if (s.cursorRow > 0) {
    const prev = s.lines[s.cursorRow - 1];
    s.lines[s.cursorRow - 1] = prev + s.lines[s.cursorRow];
    s.lines.splice(s.cursorRow, 1);
    s.cursorRow--;
    s.cursorCol = prev.length;
  }
  s.preferredCol = s.cursorCol;
  s.modified = true;
}

function deleteForward(s: State): void {
  const line = s.lines[s.cursorRow];
  if (s.cursorCol < line.length) {
    s.lines[s.cursorRow] = line.slice(0, s.cursorCol) + line.slice(s.cursorCol + 1);
  } else if (s.cursorRow < s.lines.length - 1) {
    s.lines[s.cursorRow] = line + s.lines[s.cursorRow + 1];
    s.lines.splice(s.cursorRow + 1, 1);
  }
  s.modified = true;
}

function cutLine(s: State): void {
  s.cutBuffer.push(s.lines[s.cursorRow]);
  if (s.lines.length === 1) {
    s.lines[0] = '';
    s.cursorCol = 0;
  } else {
    s.lines.splice(s.cursorRow, 1);
    if (s.cursorRow >= s.lines.length) {
      s.cursorRow = s.lines.length - 1;
    }
    s.cursorCol = Math.min(s.preferredCol, s.lines[s.cursorRow].length);
  }
  s.modified = true;
}

function pasteCut(s: State): void {
  if (s.cutBuffer.length === 0) return;
  for (let i = 0; i < s.cutBuffer.length; i++) {
    s.lines.splice(s.cursorRow + i, 0, s.cutBuffer[i]);
  }
  s.cursorRow += s.cutBuffer.length;
  s.cursorCol = 0;
  s.preferredCol = 0;
  s.cutBuffer = [];
  s.modified = true;
}

// ─── Cursor movement ───

function moveUp(s: State): void {
  if (s.cursorRow > 0) {
    s.cursorRow--;
    s.cursorCol = Math.min(s.preferredCol, s.lines[s.cursorRow].length);
  }
}

function moveDown(s: State): void {
  if (s.cursorRow < s.lines.length - 1) {
    s.cursorRow++;
    s.cursorCol = Math.min(s.preferredCol, s.lines[s.cursorRow].length);
  }
}

function moveLeft(s: State): void {
  if (s.cursorCol > 0) {
    s.cursorCol--;
  } else if (s.cursorRow > 0) {
    s.cursorRow--;
    s.cursorCol = s.lines[s.cursorRow].length;
  }
  s.preferredCol = s.cursorCol;
}

function moveRight(s: State): void {
  const line = s.lines[s.cursorRow];
  if (s.cursorCol < line.length) {
    s.cursorCol++;
  } else if (s.cursorRow < s.lines.length - 1) {
    s.cursorRow++;
    s.cursorCol = 0;
  }
  s.preferredCol = s.cursorCol;
}

function pageUp(s: State): void {
  const jump = s.rows - 3;
  s.cursorRow = Math.max(0, s.cursorRow - jump);
  s.cursorCol = Math.min(s.preferredCol, s.lines[s.cursorRow].length);
}

function pageDown(s: State): void {
  const jump = s.rows - 3;
  s.cursorRow = Math.min(s.lines.length - 1, s.cursorRow + jump);
  s.cursorCol = Math.min(s.preferredCol, s.lines[s.cursorRow].length);
}

// ─── Scrolling ───

function ensureVisible(s: State): void {
  const contentH = s.rows - 3;

  if (s.cursorRow < s.scrollRow) s.scrollRow = s.cursorRow;
  if (s.cursorRow >= s.scrollRow + contentH) s.scrollRow = s.cursorRow - contentH + 1;
  if (s.cursorCol < s.scrollCol) s.scrollCol = s.cursorCol;
  if (s.cursorCol >= s.scrollCol + s.cols) s.scrollCol = s.cursorCol - s.cols + 1;
}

// ─── Rendering ───

function render(s: State, out: CommandOutputStream): void {
  const contentH = s.rows - 3;
  let buf = HIDE_CURSOR;

  // Title bar
  buf += moveTo(0, 0) + INVERT;
  const mod = s.modified ? ' [Modified]' : '';
  const name = s.filePath.split('/').pop() || 'untitled';
  const left = `  nano  ${name}${mod}`;
  const right = `Line ${s.cursorRow + 1}/${s.lines.length}  `;
  const gap = Math.max(0, s.cols - left.length - right.length);
  buf += left + ' '.repeat(gap) + right + RST;

  // Content area
  for (let i = 0; i < contentH; i++) {
    const docRow = s.scrollRow + i;
    buf += moveTo(i + 1, 0) + ERASE_LINE;
    if (docRow < s.lines.length) {
      buf += s.lines[docRow].slice(s.scrollCol, s.scrollCol + s.cols);
    }
  }

  // Status / prompt line
  buf += moveTo(s.rows - 2, 0) + ERASE_LINE;
  if (s.mode === 'save-prompt') {
    buf += BOLD + 'File Name to Write: ' + RST + s.promptBuf;
  } else if (s.mode === 'search-prompt') {
    buf += BOLD + 'Search: ' + RST + s.promptBuf;
  } else if (s.mode === 'dirty-exit') {
    buf += BOLD + 'Save modified buffer? (Y/N/^C) ' + RST;
  } else if (s.statusMsg && Date.now() < s.statusExpiry) {
    buf += BOLD + s.statusMsg + RST;
  }

  // Shortcut bar
  buf += moveTo(s.rows - 1, 0) + INVERT;
  const shortcuts = s.mode === 'edit'
    ? '^X Exit  ^O Save  ^K Cut  ^U Paste  ^W Search'
    : '^C Cancel';
  buf += shortcuts.padEnd(s.cols) + RST;

  // Position cursor
  if (s.mode === 'save-prompt') {
    buf += moveTo(s.rows - 2, 20 + s.promptBuf.length);
  } else if (s.mode === 'search-prompt') {
    buf += moveTo(s.rows - 2, 8 + s.promptBuf.length);
  } else if (s.mode !== 'dirty-exit') {
    buf += moveTo(s.cursorRow - s.scrollRow + 1, s.cursorCol - s.scrollCol);
  }

  buf += SHOW_CURSOR;
  out.write(buf);
}

function setStatus(s: State, msg: string): void {
  s.statusMsg = msg;
  s.statusExpiry = Date.now() + 3000;
}

// ─── Search ───

function searchForward(s: State, query: string): boolean {
  for (let r = s.cursorRow; r < s.lines.length; r++) {
    const start = r === s.cursorRow ? s.cursorCol + 1 : 0;
    const idx = s.lines[r].indexOf(query, start);
    if (idx !== -1) {
      s.cursorRow = r;
      s.cursorCol = idx;
      s.preferredCol = idx;
      return true;
    }
  }
  // Wrap from top
  for (let r = 0; r <= s.cursorRow; r++) {
    const limit = r === s.cursorRow ? s.cursorCol : s.lines[r].length;
    const idx = s.lines[r].indexOf(query);
    if (idx !== -1 && idx < limit) {
      s.cursorRow = r;
      s.cursorCol = idx;
      s.preferredCol = idx;
      return true;
    }
  }
  return false;
}

// ─── Mode-specific key handlers ───

function handleEditKey(s: State, key: KeyEvent): boolean {
  switch (key.type) {
    case 'char': insertChar(s, key.char!); break;
    case 'enter': insertNewline(s); break;
    case 'backspace': deleteBackward(s); break;
    case 'delete': deleteForward(s); break;
    case 'tab': insertChar(s, '    '); break;
    case 'up': moveUp(s); break;
    case 'down': moveDown(s); break;
    case 'left': moveLeft(s); break;
    case 'right': moveRight(s); break;
    case 'home': s.cursorCol = 0; s.preferredCol = 0; break;
    case 'end': s.cursorCol = s.lines[s.cursorRow].length; s.preferredCol = s.cursorCol; break;
    case 'pageup': pageUp(s); break;
    case 'pagedown': pageDown(s); break;
    case 'ctrl-k': cutLine(s); break;
    case 'ctrl-u': pasteCut(s); break;
    case 'ctrl-o': s.mode = 'save-prompt'; s.promptBuf = s.filePath; break;
    case 'ctrl-w': s.mode = 'search-prompt'; s.promptBuf = ''; break;
    case 'ctrl-x':
      if (s.modified) { s.mode = 'dirty-exit'; } else { return true; }
      break;
  }
  return false;
}

function handleSavePrompt(s: State, key: KeyEvent, ctx: CommandContext): boolean {
  switch (key.type) {
    case 'enter':
      try {
        const path = resolve(ctx.cwd, s.promptBuf);
        saveFile(ctx, path, s.lines);
        s.filePath = path;
        s.modified = false;
        setStatus(s, `Wrote ${s.lines.length} lines`);
      } catch (e) {
        setStatus(s, `Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      s.mode = 'edit';
      break;
    case 'ctrl-c':
    case 'escape':
      s.mode = 'edit';
      break;
    case 'backspace':
      s.promptBuf = s.promptBuf.slice(0, -1);
      break;
    case 'char':
      s.promptBuf += key.char!;
      break;
  }
  return false;
}

function handleSearchPrompt(s: State, key: KeyEvent): boolean {
  switch (key.type) {
    case 'enter':
      if (s.promptBuf) {
        if (!searchForward(s, s.promptBuf)) {
          setStatus(s, `"${s.promptBuf}" not found`);
        }
      }
      s.mode = 'edit';
      break;
    case 'ctrl-c':
    case 'escape':
      s.mode = 'edit';
      break;
    case 'backspace':
      s.promptBuf = s.promptBuf.slice(0, -1);
      break;
    case 'char':
      s.promptBuf += key.char!;
      break;
  }
  return false;
}

function handleDirtyExit(s: State, key: KeyEvent, ctx: CommandContext): boolean {
  if (key.type === 'char') {
    if (key.char === 'y' || key.char === 'Y') {
      try { saveFile(ctx, s.filePath, s.lines); } catch { /* best effort */ }
      return true;
    }
    if (key.char === 'n' || key.char === 'N') return true;
  }
  if (key.type === 'ctrl-c' || key.type === 'escape') s.mode = 'edit';
  return false;
}

// ─── Main command ───

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    ctx.stderr.write('Usage: nano <filename>\n');
    return 1;
  }

  const filePath = resolve(ctx.cwd, ctx.args[0]);
  const rows = parseInt(ctx.env['LINES'] || '24', 10);
  const cols = parseInt(ctx.env['COLUMNS'] || '80', 10);

  ctx.setRawMode?.(true);

  try {
    const { lines, isNew } = loadFile(ctx, filePath);

    const s: State = {
      lines,
      modified: false,
      filePath,
      isNewFile: isNew,
      cursorRow: 0,
      cursorCol: 0,
      preferredCol: 0,
      scrollRow: 0,
      scrollCol: 0,
      rows,
      cols,
      mode: 'edit',
      promptBuf: '',
      statusMsg: isNew ? '[ New File ]' : '',
      statusExpiry: isNew ? Date.now() + 3000 : 0,
      cutBuffer: [],
    };

    ctx.stdout.write(CLEAR + HOME);
    render(s, ctx.stdout);

    while (true) {
      const data = await ctx.stdin?.read();
      if (data === null || data === undefined) break;

      let shouldExit = false;

      // Single keypress or escape sequence
      if (data.startsWith('\x1b') || data.length === 1) {
        const key = parseKey(data);
        switch (s.mode) {
          case 'edit': shouldExit = handleEditKey(s, key); break;
          case 'save-prompt': shouldExit = handleSavePrompt(s, key, ctx); break;
          case 'search-prompt': shouldExit = handleSearchPrompt(s, key); break;
          case 'dirty-exit': shouldExit = handleDirtyExit(s, key, ctx); break;
        }
      } else {
        // Pasted text -- insert each character
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') insertNewline(s);
          else if (ch.charCodeAt(0) >= 32) insertChar(s, ch);
        }
      }

      if (shouldExit) break;

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
