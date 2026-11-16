import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve, basename } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  force: { type: 'boolean' as const, short: 'f' },
  interactive: { type: 'boolean' as const, short: 'i' },
  'no-clobber': { type: 'boolean' as const, short: 'n' },
  verbose: { type: 'boolean' as const, short: 'v' },
  'no-target-directory': { type: 'boolean' as const, short: 'T' },
};

/**
 * mv [-finvT] SOURCE... DEST
 *
 * Every SOURCE is moved, not only the first: with several sources DEST must be an existing
 * directory, as in coreutils. Reading only args[0] and args[1] turned `mv a b c dir/` into
 * `mv a b` (b overwritten, c and dir ignored) and still exited 0.
 */
const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);
  if (positional.length < 2) {
    ctx.stderr.write(
      positional.length ? `mv: missing destination file operand after '${positional[0]}'\n` : 'mv: missing file operand\n'
    );
    return 1;
  }

  const sources = positional.slice(0, -1);
  const destArg = positional[positional.length - 1];
  const dest = resolve(ctx.cwd, destArg);
  const destIsDir = !flags['no-target-directory'] && ctx.vfs.exists(dest) && ctx.vfs.stat(dest).type === 'directory';

  if (sources.length > 1 && !destIsDir) {
    ctx.stderr.write(`mv: target '${destArg}' is not a directory\n`);
    return 1;
  }

  let exitCode = 0;
  for (const srcArg of sources) {
    const src = resolve(ctx.cwd, srcArg);
    const target = destIsDir ? resolve(dest, basename(src)) : dest;
    try {
      if (!ctx.vfs.exists(src)) {
        ctx.stderr.write(`mv: cannot stat '${srcArg}': No such file or directory\n`);
        exitCode = 1;
        continue;
      }
      if (target === src) {
        ctx.stderr.write(`mv: '${srcArg}' and '${destArg}' are the same file\n`);
        exitCode = 1;
        continue;
      }
      if (target.startsWith(`${src}/`)) {
        ctx.stderr.write(`mv: cannot move '${srcArg}' to a subdirectory of itself, '${destArg}'\n`);
        exitCode = 1;
        continue;
      }
      if (ctx.vfs.exists(target)) {
        if (flags['no-clobber']) continue;
        const srcDir = ctx.vfs.stat(src).type === 'directory';
        const targetDir = ctx.vfs.stat(target).type === 'directory';
        if (targetDir && !srcDir) {
          ctx.stderr.write(`mv: cannot overwrite directory '${target}' with non-directory\n`);
          exitCode = 1;
          continue;
        }
        if (srcDir && !targetDir) {
          ctx.stderr.write(`mv: cannot overwrite non-directory '${target}' with directory '${srcArg}'\n`);
          exitCode = 1;
          continue;
        }
        if (targetDir) {
          if (ctx.vfs.readdir(target).length) {
            ctx.stderr.write(`mv: cannot move '${srcArg}' to '${target}': Directory not empty\n`);
            exitCode = 1;
            continue;
          }
          ctx.vfs.rmdir(target);
        } else {
          ctx.vfs.unlink(target);
        }
      }
      ctx.vfs.rename(src, target);
      if (flags.verbose) ctx.stdout.write(`renamed '${srcArg}' -> '${target}'\n`);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`mv: ${e.message}\n`);
        exitCode = 1;
        continue;
      }
      throw e;
    }
  }
  return exitCode;
};

export default command;
