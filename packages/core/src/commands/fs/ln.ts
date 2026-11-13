import type { Command } from '../types.js';
import { resolve, basename } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

/**
 * ln -s TARGET [LINK_NAME]  |  ln -s TARGET... DIRECTORY
 *
 * Symbolic links only: the VFS has no hard links (an inode shared by two names), so `ln` without
 * -s explains that instead of silently copying.
 */
const command: Command = async (ctx) => {
  let symbolic = false;
  let force = false;
  let noDeref = false;
  const args: string[] = [];
  for (const arg of ctx.args) {
    if (/^-[sfnTv]+$/.test(arg)) {
      if (arg.includes('s')) symbolic = true;
      if (arg.includes('f')) force = true;
      if (arg.includes('n') || arg.includes('T')) noDeref = true;
    } else if (arg === '--symbolic') symbolic = true;
    else if (arg === '--force') force = true;
    else if (arg === '--no-dereference') noDeref = true;
    else args.push(arg);
  }

  if (!symbolic) {
    ctx.stderr.write('ln: hard links are not supported in Lifo VFS (use ln -s)\n');
    return 1;
  }
  if (args.length === 0) {
    ctx.stderr.write('ln: missing file operand\n');
    return 1;
  }

  // Where each link goes: one target and no name links into the current directory; the last
  // operand is a directory to link into when it is one (unless -n) or when there are several targets.
  let targets: string[];
  let dest: string;
  if (args.length === 1) {
    targets = args;
    dest = ctx.cwd;
  } else {
    targets = args.slice(0, -1);
    dest = resolve(ctx.cwd, args[args.length - 1]);
  }
  const intoDir =
    args.length === 1 ||
    targets.length > 1 ||
    (!noDeref && ctx.vfs.exists(dest) && ctx.vfs.stat(dest).type === 'directory');

  let code = 0;
  for (const target of targets) {
    const link = intoDir ? resolve(dest, basename(target)) : dest;
    try {
      if (force) {
        try {
          if (ctx.vfs.lstat(link).type !== 'directory') ctx.vfs.unlink(link);
        } catch {
          // nothing there
        }
      }
      ctx.vfs.symlink(target, link);
    } catch (e) {
      if (!(e instanceof VFSError)) throw e;
      const reason = e.code === 'EEXIST' ? 'File exists' : e.message;
      ctx.stderr.write(`ln: failed to create symbolic link '${link}': ${reason}\n`);
      code = 1;
    }
  }
  return code;
};

export default command;
