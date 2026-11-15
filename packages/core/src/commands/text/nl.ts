import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { isBinaryFile } from '../../utils/mime.js';

const spec = {
  'body-numbering': { type: 'string' as const, short: 'b' },
  'number-width': { type: 'string' as const, short: 'w' },
};

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);

  const style = (flags['body-numbering'] as string) || 't';
  const width = parseInt((flags['number-width'] as string) || '6', 10);

  let content: string;

  if (positional.length === 0 || positional[0] === '-') {
    if (ctx.stdin) {
      content = await ctx.stdin.readAll();
    } else {
      ctx.stderr.write('nl: missing operand\n');
      return 1;
    }
  } else {
    const path = resolve(ctx.cwd, positional[0]);
    if (isBinaryFile(ctx.vfs, path)) {
      ctx.stderr.write(`nl: ${positional[0]}: binary file, skipping
`);
      return 1;
    }
    try {
      content = ctx.vfs.readFileString(path);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`nl: ${positional[0]}: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }

  const lines = content.split('\n');
  // If content ends with \n, the last element is empty and shouldn't be numbered
  const hasTrailingNewline = content.endsWith('\n');
  let lineNum = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip last empty element from trailing newline
    if (i === lines.length - 1 && hasTrailingNewline && line === '') {
      break;
    }

    const shouldNumber =
      style === 'a' ? true :             // all lines
      style === 't' ? line.length > 0 :  // non-empty (default)
      false;                              // 'n' = none

    if (shouldNumber) {
      ctx.stdout.write(`${String(lineNum).padStart(width, ' ')}\t${line}\n`);
      lineNum++;
    } else {
      ctx.stdout.write(`${' '.repeat(width)}\t${line}\n`);
    }
  }

  return 0;
};

export default command;
