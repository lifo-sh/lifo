import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { isBinaryFile } from '../../utils/mime.js';

const command: Command = async (ctx) => {
  let reverse = false;
  let numeric = false;
  let unique = false;
  let keyField = 0; // 0 = whole line, 1-based field index
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-k' && i + 1 < ctx.args.length) {
      keyField = parseInt(ctx.args[++i], 10);
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        switch (arg[j]) {
          case 'r': reverse = true; break;
          case 'n': numeric = true; break;
          case 'u': unique = true; break;
        }
      }
    } else {
      files.push(arg);
    }
  }

  let text = '';
  if (files.length === 0) {
    if (ctx.stdin) {
      text = await ctx.stdin.readAll();
    } else {
      ctx.stderr.write('sort: missing file operand\n');
      return 1;
    }
  } else {
    for (const file of files) {
      const path = resolve(ctx.cwd, file);
      try {
        ctx.vfs.stat(path);
        if (isBinaryFile(ctx.vfs, path)) {
          ctx.stderr.write(`sort: ${file}: binary file, skipping\n`);
          continue;
        }
        text += ctx.vfs.readFileString(path);
      } catch (e) {
        if (e instanceof VFSError) {
          ctx.stderr.write(`sort: ${file}: ${e.message}\n`);
          return 1;
        }
        throw e;
      }
    }
  }

  let lines = text.replace(/\n$/, '').split('\n');

  function getKey(line: string): string {
    if (keyField > 0) {
      const fields = line.split(/\s+/);
      return fields[keyField - 1] || '';
    }
    return line;
  }

  lines.sort((a, b) => {
    const ka = getKey(a);
    const kb = getKey(b);
    let cmp: number;
    if (numeric) {
      cmp = (parseFloat(ka) || 0) - (parseFloat(kb) || 0);
    } else {
      cmp = ka.localeCompare(kb);
    }
    return reverse ? -cmp : cmp;
  });

  if (unique) {
    lines = lines.filter((line, idx) => idx === 0 || line !== lines[idx - 1]);
  }

  ctx.stdout.write(lines.join('\n') + '\n');
  return 0;
};

export default command;
