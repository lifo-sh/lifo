import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  recursive: { type: 'boolean' as const, short: 'r' },
  Recursive: { type: 'boolean' as const, short: 'R' },
  force: { type: 'boolean' as const, short: 'f' },
};

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);
  const recursive = (flags.recursive || flags.Recursive) as boolean;
  const force = flags.force as boolean;

  if (positional.length === 0) {
    ctx.stderr.write('rm: missing operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const arg of positional) {
    const path = resolve(ctx.cwd, arg);
    try {
      // lstat: removing a symlink removes the link, never what it points to.
      const stat = ctx.vfs.lstat(path);
      if (stat.type === 'directory') {
        if (!recursive) {
          ctx.stderr.write(`rm: cannot remove '${arg}': Is a directory\n`);
          exitCode = 1;
          continue;
        }
        ctx.vfs.rmdirRecursive(path);
      } else {
        ctx.vfs.unlink(path);
      }
    } catch (e) {
      if (e instanceof VFSError) {
        if (!force) {
          ctx.stderr.write(`rm: ${arg}: ${e.message}\n`);
          exitCode = 1;
        }
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
