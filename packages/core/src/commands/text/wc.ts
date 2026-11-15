import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { isBinaryFile } from '../../utils/mime.js';

const command: Command = async (ctx) => {
  let showLines = false;
  let showWords = false;
  let showBytes = false;
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        switch (arg[j]) {
          case 'l': showLines = true; break;
          case 'w': showWords = true; break;
          case 'c': showBytes = true; break;
        }
      }
    } else {
      files.push(arg);
    }
  }

  // Default: show all
  if (!showLines && !showWords && !showBytes) {
    showLines = showWords = showBytes = true;
  }

  function countText(text: string): { lines: number; words: number; bytes: number } {
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const bytes = new TextEncoder().encode(text).length;
    return { lines, words, bytes };
  }

  function formatCounts(c: { lines: number; words: number; bytes: number }, name?: string): string {
    const parts: string[] = [];
    if (showLines) parts.push(String(c.lines).padStart(8));
    if (showWords) parts.push(String(c.words).padStart(8));
    if (showBytes) parts.push(String(c.bytes).padStart(8));
    if (name) parts.push(' ' + name);
    return parts.join('') + '\n';
  }

  if (files.length === 0) {
    if (ctx.stdin) {
      const text = await ctx.stdin.readAll();
      const counts = countText(text);
      ctx.stdout.write(formatCounts(counts));
    } else {
      ctx.stderr.write('wc: missing file operand\n');
      return 1;
    }
    return 0;
  }

  let exitCode = 0;
  let totalLines = 0;
  let totalWords = 0;
  let totalBytes = 0;

  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      ctx.vfs.stat(path);
      if (isBinaryFile(ctx.vfs, path)) {
        if (showBytes && !showLines && !showWords) {
          // Byte count only: use readFile for accurate binary size
          const data = ctx.vfs.readFile(path);
          const counts = { lines: 0, words: 0, bytes: data.byteLength };
          totalBytes += counts.bytes;
          ctx.stdout.write(formatCounts(counts, file));
        } else {
          ctx.stderr.write(`wc: ${file}: binary file, skipping
`);
        }
        continue;
      }
      const content = ctx.vfs.readFileString(path);
      const counts = countText(content);
      totalLines += counts.lines;
      totalWords += counts.words;
      totalBytes += counts.bytes;
      ctx.stdout.write(formatCounts(counts, file));
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`wc: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  if (files.length > 1) {
    ctx.stdout.write(formatCounts({ lines: totalLines, words: totalWords, bytes: totalBytes }, 'total'));
  }

  return exitCode;
};

export default command;
