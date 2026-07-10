import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

const command: Command = async (ctx) => {
  let count = 10;
  let fromStart = false; // -n +N: from line N to end
  let bytes: number | null = null; // -c: byte count mode
  const files: string[] = [];

  const parseN = (s: string, what: string): number => {
    if (s.startsWith('+')) { fromStart = true; s = s.slice(1); }
    const n = parseInt(s, 10);
    if (isNaN(n)) ctx.stderr.write(`tail: invalid number of ${what}\n`);
    return n;
  };

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if ((arg === '-n' || arg === '--lines') && i + 1 < ctx.args.length) {
      count = parseN(ctx.args[++i], 'lines');
      if (isNaN(count)) return 1;
    } else if (arg.startsWith('-n') && arg.length > 2) {
      count = parseN(arg.slice(2), 'lines');
      if (isNaN(count)) return 1;
    } else if ((arg === '-c' || arg === '--bytes') && i + 1 < ctx.args.length) {
      bytes = parseN(ctx.args[++i], 'bytes');
      if (isNaN(bytes)) return 1;
    } else if (arg.startsWith('-c') && arg.length > 2) {
      bytes = parseN(arg.slice(2), 'bytes');
      if (isNaN(bytes)) return 1;
    } else if (arg === '-f' || arg === '--follow') {
      // Follow mode: we read a static snapshot (no blocking watch); accepted
      // so `tail -f log` shows current contents instead of erroring.
      continue;
    } else if (/^-\d+$/.test(arg)) {
      count = parseInt(arg.slice(1), 10);
    } else {
      files.push(arg);
    }
  }

  async function tailText(text: string): Promise<void> {
    if (bytes !== null) {
      ctx.stdout.write(fromStart ? text.slice(bytes - 1) : text.slice(-bytes));
      return;
    }
    const lines = text.replace(/\n$/, '').split('\n');
    const selected = fromStart ? lines.slice(count - 1) : lines.slice(-count);
    ctx.stdout.write(selected.join('\n') + '\n');
  }

  if (files.length === 0) {
    if (ctx.stdin) {
      await tailText(await ctx.stdin.readAll());
    } else {
      ctx.stderr.write('tail: missing file operand\n');
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
        ctx.stderr.write(`tail: ${file}: binary file, skipping\n`);
        continue;
      }
      const content = ctx.vfs.readFileString(path);
      if (files.length > 1) ctx.stdout.write(`==> ${file} <==\n`);
      await tailText(content);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`tail: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
