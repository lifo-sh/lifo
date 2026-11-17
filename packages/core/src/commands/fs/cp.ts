import type { Command } from '../types.js';
import type { VFS } from '../../kernel/vfs/index.js';
import { parseArgs } from '../../utils/args.js';
import { resolve, basename } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  recursive: { type: 'boolean' as const, short: 'r' },
  Recursive: { type: 'boolean' as const, short: 'R' },
  archive: { type: 'boolean' as const, short: 'a' },
  force: { type: 'boolean' as const, short: 'f' },
  'no-clobber': { type: 'boolean' as const, short: 'n' },
  preserve: { type: 'boolean' as const, short: 'p' },
  verbose: { type: 'boolean' as const, short: 'v' },
  'no-target-directory': { type: 'boolean' as const, short: 'T' },
};

function copyTree(vfs: VFS, src: string, dest: string, noClobber: boolean): void {
  if (vfs.stat(src).type !== 'directory') {
    if (noClobber && vfs.exists(dest)) return;
    vfs.copyFile(src, dest);
    return;
  }
  if (!vfs.exists(dest)) vfs.mkdir(dest, { recursive: true });
  for (const entry of vfs.readdir(src)) copyTree(vfs, resolve(src, entry.name), resolve(dest, entry.name), noClobber);
}

/**
 * cp [-rRafnpvT] SOURCE... DEST
 *
 * Every SOURCE is copied, not only the first: with several sources DEST must be an existing
 * directory. Directories need -r (or -R / -a), as in coreutils.
 */
const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);
  const recursive = Boolean(flags.recursive || flags.Recursive || flags.archive);
  if (positional.length < 2) {
    ctx.stderr.write(
      positional.length ? `cp: missing destination file operand after '${positional[0]}'\n` : 'cp: missing file operand\n'
    );
    return 1;
  }

  const sources = positional.slice(0, -1);
  const destArg = positional[positional.length - 1];
  const dest = resolve(ctx.cwd, destArg);
  const destIsDir = !flags['no-target-directory'] && ctx.vfs.exists(dest) && ctx.vfs.stat(dest).type === 'directory';

  if (sources.length > 1 && !destIsDir) {
    ctx.stderr.write(`cp: target '${destArg}' is not a directory\n`);
    return 1;
  }

  let exitCode = 0;
  for (const srcArg of sources) {
    const src = resolve(ctx.cwd, srcArg);
    const target = destIsDir ? resolve(dest, basename(src)) : dest;
    try {
      if (!ctx.vfs.exists(src)) {
        ctx.stderr.write(`cp: cannot stat '${srcArg}': No such file or directory\n`);
        exitCode = 1;
        continue;
      }
      const srcIsDir = ctx.vfs.stat(src).type === 'directory';
      if (srcIsDir && !recursive) {
        ctx.stderr.write(`cp: -r not specified; omitting directory '${srcArg}'\n`);
        exitCode = 1;
        continue;
      }
      if (target === src) {
        ctx.stderr.write(`cp: '${srcArg}' and '${destArg}' are the same file\n`);
        exitCode = 1;
        continue;
      }
      if (srcIsDir && target.startsWith(`${src}/`)) {
        ctx.stderr.write(`cp: cannot copy a directory, '${srcArg}', into itself, '${destArg}'\n`);
        exitCode = 1;
        continue;
      }
      if (!srcIsDir && ctx.vfs.exists(target) && ctx.vfs.stat(target).type === 'directory') {
        ctx.stderr.write(`cp: cannot overwrite directory '${target}' with non-directory\n`);
        exitCode = 1;
        continue;
      }
      copyTree(ctx.vfs, src, target, Boolean(flags['no-clobber']));
      if (flags.verbose) ctx.stdout.write(`'${srcArg}' -> '${target}'\n`);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`cp: ${e.message}\n`);
        exitCode = 1;
        continue;
      }
      throw e;
    }
  }
  return exitCode;
};

export default command;
