import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { isBinaryFile } from '../../utils/mime.js';

function parseFieldSpec(spec: string): number[] {
  const fields: number[] = [];
  for (const part of spec.split(',')) {
    const rangeParts = part.split('-');
    if (rangeParts.length === 2) {
      const start = parseInt(rangeParts[0], 10);
      const end = parseInt(rangeParts[1], 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) fields.push(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) fields.push(n);
    }
  }
  return fields;
}

const command: Command = async (ctx) => {
  let delimiter = '\t';
  let fieldSpec = '';
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-d' && i + 1 < ctx.args.length) {
      delimiter = ctx.args[++i];
    } else if (arg === '-f' && i + 1 < ctx.args.length) {
      fieldSpec = ctx.args[++i];
    } else if (arg.startsWith('-d') && arg.length > 2) {
      delimiter = arg.slice(2);
    } else if (arg.startsWith('-f') && arg.length > 2) {
      fieldSpec = arg.slice(2);
    } else {
      files.push(arg);
    }
  }

  if (!fieldSpec) {
    ctx.stderr.write('cut: you must specify a list of fields\n');
    return 1;
  }

  const fields = parseFieldSpec(fieldSpec);

  function cutLine(line: string): string {
    const parts = line.split(delimiter);
    return fields.map((f) => parts[f - 1] || '').join(delimiter);
  }

  let text = '';
  if (files.length === 0) {
    if (ctx.stdin) {
      text = await ctx.stdin.readAll();
    } else {
      ctx.stderr.write('cut: missing file operand\n');
      return 1;
    }
  } else {
    for (const file of files) {
      const path = resolve(ctx.cwd, file);
      try {
        ctx.vfs.stat(path);
        if (isBinaryFile(ctx.vfs, path)) {
          ctx.stderr.write(`cut: ${file}: binary file, skipping\n`);
          continue;
        }
        text += ctx.vfs.readFileString(path);
      } catch (e) {
        if (e instanceof VFSError) {
          ctx.stderr.write(`cut: ${file}: ${e.message}\n`);
          return 1;
        }
        throw e;
      }
    }
  }

  const lines = text.replace(/\n$/, '').split('\n');
  for (const line of lines) {
    ctx.stdout.write(cutLine(line) + '\n');
  }

  return 0;
};

export default command;
