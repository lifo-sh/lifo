import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { BOLD, BLUE, RESET } from '../../utils/colors.js';
import { VFSError } from '../../kernel/vfs/index.js';

const spec = {
  long: { type: 'boolean' as const, short: 'l' },
  all: { type: 'boolean' as const, short: 'a' },
  one: { type: 'boolean' as const, short: '1' },
};

function formatMode(mode: number, type: LsEntry['type']): string {
  const d = type === 'directory' ? 'd' : type === 'symlink' ? 'l' : '-';
  const perms = [
    (mode & 0o400) ? 'r' : '-',
    (mode & 0o200) ? 'w' : '-',
    (mode & 0o100) ? 'x' : '-',
    (mode & 0o040) ? 'r' : '-',
    (mode & 0o020) ? 'w' : '-',
    (mode & 0o010) ? 'x' : '-',
    (mode & 0o004) ? 'r' : '-',
    (mode & 0o002) ? 'w' : '-',
    (mode & 0o001) ? 'x' : '-',
  ].join('');
  return d + perms;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mon} ${day} ${hour}:${min}`;
}

interface LsEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  /** For a symlink in a long listing: shown as `name -> target`. */
  target?: string;
  size: number;
  mtime: number;
  mode: number;
}

function formatEntry(entry: LsEntry, long: boolean, color = true): string {
  const displayName = color && entry.type === 'directory'
    ? `${BOLD}${BLUE}${entry.name}${RESET}`
    : entry.name;

  if (long) {
    const mode = formatMode(entry.mode, entry.type);
    const size = String(entry.size).padStart(6, ' ');
    const date = formatDate(entry.mtime);
    const link = entry.type === 'symlink' && entry.target !== undefined ? ` -> ${entry.target}` : '';
    return `${mode}  1 user user ${size} ${date} ${displayName}${link}\n`;
  }
  return displayName;
}

function listDirectory(
  path: string, flags: Record<string, string | boolean>, ctx: import('../types.js').CommandContext,
): LsEntry[] {
  const entries = ctx.vfs.readdirStat(path);
  const filtered = (flags.all as boolean)
    ? entries
    : entries.filter((e) => !e.name.startsWith('.'));
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of filtered as LsEntry[]) {
    if (e.type !== 'symlink') continue;
    try {
      e.target = ctx.vfs.readlink(path === '/' ? `/${e.name}` : `${path}/${e.name}`);
    } catch {
      // gone between the listing and now
    }
  }
  return filtered;
}

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);
  const targets = positional.length > 0 ? positional : [ctx.cwd];
  // Like GNU ls: colours and the multi-column layout only on a terminal; into a pipe, a file
  // or a capture (`ls | wc -l`, `$(ls)`, commands.run) it writes one plain name per line.
  const tty = ctx.stdout.isTTY === true;
  const one = !!flags.one || !tty;
  const fmt = (entry: LsEntry, long: boolean) => formatEntry(entry, long, tty);

  let exitCode = 0;
  const fileEntries: LsEntry[] = [];
  const dirTargets: string[] = [];

  // First pass: separate files from directories
  for (const target of targets) {
    const targetPath = resolve(ctx.cwd, target);
    try {
      const stat = ctx.vfs.stat(targetPath);
      if (stat.type === 'file') {
        fileEntries.push({
          name: target,
          type: stat.type,
          size: stat.size,
          mtime: stat.mtime,
          mode: stat.mode,
        });
      } else {
        dirTargets.push(target);
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`ls: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  // Display file entries
  if (fileEntries.length > 0) {
    if (flags.long) {
      for (const entry of fileEntries) {
        ctx.stdout.write(fmt(entry, true));
      }
    } else if (one) {
      for (const entry of fileEntries) {
        ctx.stdout.write(fmt(entry, false) + '\n');
      }
    } else {
      const names = fileEntries.map((e) => fmt(e, false));
      ctx.stdout.write(names.join('  ') + '\n');
    }
  }

  // Display directory entries
  for (let i = 0; i < dirTargets.length; i++) {
    const target = dirTargets[i];
    const targetPath = resolve(ctx.cwd, target);

    // Print header if multiple targets
    if (dirTargets.length > 1 || fileEntries.length > 0) {
      if (fileEntries.length > 0 || i > 0) ctx.stdout.write('\n');
      ctx.stdout.write(`${target}:\n`);
    }

    try {
      const entries = listDirectory(targetPath, flags, ctx);

      if (flags.long) {
        for (const entry of entries) {
          ctx.stdout.write(fmt(entry, true));
        }
      } else if (one) {
        for (const entry of entries) {
          ctx.stdout.write(fmt(entry, false) + '\n');
        }
      } else {
        const names = entries.map((e) => fmt(e, false));
        if (names.length > 0) {
          ctx.stdout.write(names.join('  ') + '\n');
        }
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`ls: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
