import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    ctx.stderr.write('realpath: missing operand\n');
    return 1;
  }

  let exitCode = 0;

  for (const arg of ctx.args) {
    const path = resolve(ctx.cwd, arg);
    try {
      ctx.stdout.write(ctx.vfs.realpath(path) + '\n');
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`realpath: ${arg}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
