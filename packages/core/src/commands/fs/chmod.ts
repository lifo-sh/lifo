import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

function parseMode(modeStr: string, currentMode: number): number {
  // Octal mode: 755, 644, etc.
  if (/^[0-7]+$/.test(modeStr)) {
    return parseInt(modeStr, 8);
  }

  // Symbolic mode: +x, -w, u+rwx, etc.
  let mode = currentMode;
  const match = modeStr.match(/^([ugoa]*)([+\-=])([rwx]+)$/);
  if (!match) return mode;

  const who = match[1] || 'a';
  const op = match[2];
  const perms = match[3];

  let bits = 0;
  if (perms.includes('r')) bits |= 4;
  if (perms.includes('w')) bits |= 2;
  if (perms.includes('x')) bits |= 1;

  const targets: number[] = [];
  if (who.includes('u') || who.includes('a')) targets.push(6); // user bits shift
  if (who.includes('g') || who.includes('a')) targets.push(3); // group bits shift
  if (who.includes('o') || who.includes('a')) targets.push(0); // other bits shift

  for (const shift of targets) {
    const shifted = bits << shift;
    if (op === '+') mode |= shifted;
    else if (op === '-') mode &= ~shifted;
    else if (op === '=') {
      mode &= ~(7 << shift);
      mode |= shifted;
    }
  }

  return mode;
}

const command: Command = async (ctx) => {
  let recursive = false;
  let modeStr = '';
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (arg === '-R' || arg === '-r') {
      recursive = true;
    } else if (!modeStr) {
      modeStr = arg;
    } else {
      files.push(arg);
    }
  }

  if (!modeStr || files.length === 0) {
    ctx.stderr.write('chmod: missing operand\n');
    return 1;
  }

  function applyChmod(filePath: string): void {
    const st = ctx.vfs.stat(filePath);
    if (st.type === 'directory' && recursive) {
      for (const entry of ctx.vfs.readdir(filePath)) {
        if (entry.type === 'symlink') continue; // like chmod -R: links inside the tree aren't followed
        applyChmod(filePath === '/' ? '/' + entry.name : filePath + '/' + entry.name);
      }
    }
    ctx.vfs.chmod(filePath, parseMode(modeStr, st.mode));
  }

  let exitCode = 0;

  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      applyChmod(path);
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`chmod: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
