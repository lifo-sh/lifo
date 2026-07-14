import type { Command, CommandOutputStream } from '@lifo-sh/core';
import { resolve, VFSError } from '@lifo-sh/core';

// ─── ANSI ───

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
  | 'char' | 'enter' | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'backspace' | 'escape' | 'unknown';

interface KeyEvent {
  type: KeyType;
  char?: string;
}

function parseKey(data: string): KeyEvent {
  if (data === '\r') return { type: 'enter' };
  if (data === '\x7f' || data === '\b') return { type: 'backspace' };
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
    if (seq === '5~') return { type: 'pageup' };
    if (seq === '6~') return { type: 'pagedown' };
    return { type: 'unknown' };
  }

  if (data.length >= 1 && data.charCodeAt(0) >= 32) {
    return { type: 'char', char: data };
  }

  return { type: 'unknown' };
}

// ─── State ───

type Mode = 'view' | 'search';

interface State {
  lines: string[];
  scrollRow: number;
  scrollCol: number;
  rows: number;
  cols: number;
  fileName: string;

  mode: Mode;
  searchBuf: string;
  searchQuery: string;
  searchMatches: number[];
  currentMatch: number;
}

// ─── Content height (screen minus status bar) ───

function contentHeight(s: State): number {
  return s.rows - 1;
}

// ─── Search ───

function findMatches(lines: string[], query: string): number[] {
  const matches: number[] = [];
  if (!query) return matches;
  const lower = query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lower)) matches.push(i);
  }
  return matches;
}

function jumpToNextMatch(s: State): void {
  if (s.searchMatches.length === 0) return;
  // Find the first match after current scroll position
  for (let i = 0; i < s.searchMatches.length; i++) {
    if (s.searchMatches[i] > s.scrollRow) {
      s.currentMatch = i;
      s.scrollRow = s.searchMatches[i];
      return;
    }
  }
  // Wrap to first match
  s.currentMatch = 0;
  s.scrollRow = s.searchMatches[0];
}

function jumpToPrevMatch(s: State): void {
  if (s.searchMatches.length === 0) return;
  for (let i = s.searchMatches.length - 1; i >= 0; i--) {
    if (s.searchMatches[i] < s.scrollRow) {
      s.currentMatch = i;
      s.scrollRow = s.searchMatches[i];
      return;
    }
  }
  // Wrap to last match
  s.currentMatch = s.searchMatches.length - 1;
  s.scrollRow = s.searchMatches[s.currentMatch];
}

// ─── Rendering ───

function render(s: State, out: CommandOutputStream): void {
  const ch = contentHeight(s);
  let buf = HIDE_CURSOR;

  for (let i = 0; i < ch; i++) {
    const docRow = s.scrollRow + i;
    buf += moveTo(i, 0) + ERASE_LINE;
    if (docRow < s.lines.length) {
      let line = s.lines[docRow].slice(s.scrollCol, s.scrollCol + s.cols);
      // Highlight search matches
      if (s.searchQuery && line.toLowerCase().includes(s.searchQuery.toLowerCase())) {
        line = highlightMatches(line, s.searchQuery);
      }
      buf += line;
    } else {
      buf += '~';
    }
  }

  // Status bar
  buf += moveTo(s.rows - 1, 0) + INVERT + ERASE_LINE;
  if (s.mode === 'search') {
    buf += '/' + s.searchBuf;
  } else {
    const pct = s.lines.length <= ch
      ? '(END)'
      : s.scrollRow + ch >= s.lines.length
        ? '(END)'
        : `${Math.round(((s.scrollRow + ch) / s.lines.length) * 100)}%`;
    const matchInfo = s.searchQuery && s.searchMatches.length > 0
      ? `  [${s.currentMatch + 1}/${s.searchMatches.length}]`
      : '';
    const info = `${s.fileName} ${pct}${matchInfo}`;
    buf += info.padEnd(s.cols);
  }
  buf += RST + SHOW_CURSOR;

  out.write(buf);
}

function highlightMatches(line: string, query: string): string {
  const lower = line.toLowerCase();
  const qLower = query.toLowerCase();
  let result = '';
  let pos = 0;
  while (pos < line.length) {
    const idx = lower.indexOf(qLower, pos);
    if (idx === -1) {
      result += line.slice(pos);
      break;
    }
    result += line.slice(pos, idx);
    result += BOLD + INVERT + line.slice(idx, idx + query.length) + RST;
    pos = idx + query.length;
  }
  return result;
}

// ─── Key handlers ───

function handleViewKey(s: State, key: KeyEvent): boolean {
  const ch = contentHeight(s);
  switch (key.type) {
    case 'char':
      switch (key.char) {
        case 'q': return true;
        case 'j': s.scrollRow = Math.min(s.scrollRow + 1, maxScroll(s)); break;
        case 'k': s.scrollRow = Math.max(s.scrollRow - 1, 0); break;
        case 'f': case ' ': s.scrollRow = Math.min(s.scrollRow + ch, maxScroll(s)); break;
        case 'b': s.scrollRow = Math.max(s.scrollRow - ch, 0); break;
        case 'd': s.scrollRow = Math.min(s.scrollRow + Math.floor(ch / 2), maxScroll(s)); break;
        case 'u': s.scrollRow = Math.max(s.scrollRow - Math.floor(ch / 2), 0); break;
        case 'g': s.scrollRow = 0; break;
        case 'G': s.scrollRow = maxScroll(s); break;
        case '/': s.mode = 'search'; s.searchBuf = ''; break;
        case 'n': jumpToNextMatch(s); break;
        case 'N': jumpToPrevMatch(s); break;
        case 'h': s.scrollCol = Math.max(s.scrollCol - 1, 0); break;
        case 'l': s.scrollCol++; break;
      }
      break;
    case 'up': s.scrollRow = Math.max(s.scrollRow - 1, 0); break;
    case 'down': s.scrollRow = Math.min(s.scrollRow + 1, maxScroll(s)); break;
    case 'pageup': s.scrollRow = Math.max(s.scrollRow - ch, 0); break;
    case 'pagedown': s.scrollRow = Math.min(s.scrollRow + ch, maxScroll(s)); break;
    case 'home': s.scrollRow = 0; break;
    case 'end': s.scrollRow = maxScroll(s); break;
    case 'left': s.scrollCol = Math.max(s.scrollCol - 1, 0); break;
    case 'right': s.scrollCol++; break;
  }
  return false;
}

function handleSearchKey(s: State, key: KeyEvent): void {
  switch (key.type) {
    case 'enter':
      s.searchQuery = s.searchBuf;
      s.searchMatches = findMatches(s.lines, s.searchQuery);
      s.currentMatch = -1;
      s.mode = 'view';
      if (s.searchMatches.length > 0) {
        jumpToNextMatch(s);
      }
      break;
    case 'escape':
      s.mode = 'view';
      break;
    case 'backspace':
      s.searchBuf = s.searchBuf.slice(0, -1);
      break;
    case 'char':
      s.searchBuf += key.char!;
      break;
  }
}

function maxScroll(s: State): number {
  return Math.max(0, s.lines.length - contentHeight(s));
}

// ─── Main command ───

const command: Command = async (ctx) => {
  let content: string;
  let fileName: string;

  if (ctx.args.length > 0) {
    const path = resolve(ctx.cwd, ctx.args[0]);
    try {
      content = ctx.vfs.readFileString(path);
      fileName = ctx.args[0];
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`less: ${ctx.args[0]}: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  } else if (ctx.stdin) {
    content = await ctx.stdin.readAll();
    fileName = '(stdin)';
  } else {
    ctx.stderr.write('Usage: less FILE\n');
    ctx.stderr.write('View file contents one screen at a time. q to quit, / to search.\n');
    return 1;
  }

  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) lines.push('');

  const rows = parseInt(ctx.env['LINES'] || '24', 10);
  const cols = parseInt(ctx.env['COLUMNS'] || '80', 10);

  // If content fits on screen, just print it and exit (like real less with -F)
  if (lines.length <= rows - 1) {
    ctx.stdout.write(content);
    return 0;
  }

  ctx.setRawMode?.(true);

  try {
    const s: State = {
      lines,
      scrollRow: 0,
      scrollCol: 0,
      rows,
      cols,
      fileName,
      mode: 'view',
      searchBuf: '',
      searchQuery: '',
      searchMatches: [],
      currentMatch: -1,
    };

    ctx.stdout.write(CLEAR + HOME);
    render(s, ctx.stdout);

    while (true) {
      const data = await ctx.stdin?.read();
      if (data === null || data === undefined) break;

      const key = parseKey(data);
      let shouldExit = false;

      if (s.mode === 'view') {
        shouldExit = handleViewKey(s, key);
      } else {
        handleSearchKey(s, key);
      }

      if (shouldExit) break;
      render(s, ctx.stdout);
    }

    ctx.stdout.write(CLEAR + HOME + SHOW_CURSOR);
  } finally {
    ctx.setRawMode?.(false);
  }

  return 0;
};

export default command;
