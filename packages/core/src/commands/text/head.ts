import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

/** Parse head/tail-style counts with size suffixes: 300, 1k, 2M. */
function parseCount(s: string): number {
  const m = /^(\d+)([kKmMgG]?)$/.exec(s);
  if (!m) return NaN;
  const mult = { '': 1, k: 1024, K: 1024, m: 1024 ** 2, M: 1024 ** 2, g: 1024 ** 3, G: 1024 ** 3 }[m[2]] ?? 1;
  return parseInt(m[1], 10) * mult;
}

const command: Command = async (ctx) => {
  let count = 10;
  let bytes: number | null = null; // -c: byte count mode
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if ((arg === '-n' || arg === '--lines') && i + 1 < ctx.args.length) {
      count = parseCount(ctx.args[++i]);
      if (isNaN(count)) { ctx.stderr.write('head: invalid number of lines\n'); return 1; }
    } else if (arg.startsWith('-n') && arg.length > 2) {
      count = parseCount(arg.slice(2));
      if (isNaN(count)) { ctx.stderr.write('head: invalid number of lines\n'); return 1; }
    } else if ((arg === '-c' || arg === '--bytes') && i + 1 < ctx.args.length) {
      bytes = parseCount(ctx.args[++i]);
      if (isNaN(bytes)) { ctx.stderr.write('head: invalid number of bytes\n'); return 1; }
    } else if (arg.startsWith('-c') && arg.length > 2) {
      bytes = parseCount(arg.slice(2));
      if (isNaN(bytes)) { ctx.stderr.write('head: invalid number of bytes\n'); return 1; }
    } else if (/^-\d+$/.test(arg)) {
      count = parseInt(arg.slice(1), 10);
    } else {
      files.push(arg);
    }
  }

  async function headText(text: string): Promise<void> {
    if (bytes !== null) {
      ctx.stdout.write(text.slice(0, bytes));
      return;
    }
    const lines = text.split('\n');
    const selected = lines.slice(0, count);
    let output = selected.join('\n');
    // Preserve trailing newline behavior: if original had more lines, add newline
    if (lines.length > count) {
      output += '\n';
    }
    ctx.stdout.write(output);
  }

  if (files.length === 0) {
    if (ctx.stdin) {
      await headText(await ctx.stdin.readAll());
    } else {
      ctx.stderr.write('head: missing file operand\n');
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
        ctx.stderr.write(`head: ${file}: binary file, skipping\n`);
        continue;
      }
      const content = ctx.vfs.readFileString(path);
      if (files.length > 1) ctx.stdout.write(`==> ${file} <==\n`);
      await headText(content);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`head: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
