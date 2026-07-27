import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

/**
 * Shell-style glob to RegExp, for --include / --exclude / --exclude-dir.
 *
 * Only the subset those options actually use: `*`, `?`, and character classes. A pattern without a
 * slash matches the BASENAME, which is what `--include="*.ts"` means.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) out += '\\[';
      else {
        out += glob.slice(i, end + 1);
        i = end;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

const command: Command = async (ctx) => {
  const args = ctx.args;
  let ignoreCase = false;
  let invert = false;
  let lineNumbers = false;
  let countOnly = false;
  let filesWithMatches = false;
  let recursive = false;
  let wordMatch = false;
  let pattern = '';
  const files: string[] = [];
  const includeGlobs: RegExp[] = [];
  const excludeGlobs: RegExp[] = [];
  const excludeDirGlobs: RegExp[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      // End of options. The pattern may still be ahead of us: `grep -- -pattern file` is the whole
      // point of `--`. Breaking straight out left `pattern` empty and every remaining argument —
      // including the pattern itself — was pushed into `files`, so the command failed with
      // "missing pattern".
      i++;
      if (!pattern && i < args.length) {
        pattern = args[i++];
      }
      break;
    }

    // Long options. Previously these fell through to the file loop, so `--include=*.ts` was treated
    // as a filename: grep printed "no such file or directory" to stderr and still exited 0 because
    // other files matched. Silently searching the wrong set is worse than refusing.
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const takeValue = (): string | undefined => {
        if (inlineValue !== undefined) return inlineValue;
        // GNU also accepts `--include GLOB`.
        return args[++i];
      };

      switch (name) {
        case 'include': {
          const value = takeValue();
          if (value) includeGlobs.push(globToRegExp(value));
          break;
        }
        case 'exclude': {
          const value = takeValue();
          if (value) excludeGlobs.push(globToRegExp(value));
          break;
        }
        case 'exclude-dir': {
          const value = takeValue();
          if (value) excludeDirGlobs.push(globToRegExp(value.replace(/\/$/, '')));
          break;
        }
        case 'ignore-case': ignoreCase = true; break;
        case 'invert-match': invert = true; break;
        case 'line-number': lineNumbers = true; break;
        case 'count': countOnly = true; break;
        case 'files-with-matches': filesWithMatches = true; break;
        case 'recursive': recursive = true; break;
        case 'word-regexp': wordMatch = true; break;
        case 'extended-regexp': break; // JS regex is already ERE
        default:
          ctx.stderr.write(`grep: unrecognized option '${arg}'\n`);
          return 2;
      }
      i++;
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && arg[1] !== '-') {
      for (let j = 1; j < arg.length; j++) {
        switch (arg[j]) {
          case 'i': ignoreCase = true; break;
          case 'v': invert = true; break;
          case 'n': lineNumbers = true; break;
          case 'c': countOnly = true; break;
          case 'l': filesWithMatches = true; break;
          case 'r': recursive = true; break;
          case 'R': recursive = true; break;
          case 'E': break; // JS regex is already ERE
          case 'w': wordMatch = true; break;
        }
      }
      i++;
    } else if (!pattern) {
      pattern = arg;
      i++;
    } else {
      break;
    }
  }

  while (i < args.length) {
    files.push(args[i++]);
  }

  if (!pattern) {
    ctx.stderr.write('grep: missing pattern\n');
    return 2;
  }

  let regexPattern = pattern;
  if (wordMatch) {
    regexPattern = `\\b${regexPattern}\\b`;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(regexPattern, ignoreCase ? 'i' : '');
  } catch {
    ctx.stderr.write(`grep: invalid regex: ${pattern}\n`);
    return 2;
  }

  let matched = false;
  const multiFile = files.length > 1 || recursive;

  /** --include / --exclude, matched against the basename as GNU grep does. */
  function fileIsSearchable(path: string): boolean {
    const name = basename(path);
    if (excludeGlobs.some((re) => re.test(name))) return false;
    if (includeGlobs.length && !includeGlobs.some((re) => re.test(name))) return false;
    return true;
  }

  async function grepLines(lines: string[], fileName: string | null): Promise<void> {
    let count = 0;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const matches = regex.test(line);
      if (matches !== invert) {
        matched = true;
        count++;
        if (filesWithMatches) {
          if (fileName) ctx.stdout.write(fileName + '\n');
          return;
        }
        if (!countOnly) {
          let output = '';
          if (multiFile && fileName) output += fileName + ':';
          if (lineNumbers) output += (idx + 1) + ':';
          output += line + '\n';
          ctx.stdout.write(output);
        }
      }
    }
    if (countOnly) {
      let output = '';
      if (multiFile && fileName) output += fileName + ':';
      output += count + '\n';
      ctx.stdout.write(output);
    }
  }

  function walkDir(dirPath: string): string[] {
    const result: string[] = [];
    try {
      const entries = ctx.vfs.readdir(dirPath);
      for (const entry of entries) {
        const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
        if (entry.type === 'file') {
          result.push(fullPath);
        } else if (entry.type === 'directory') {
          // Pruned during the walk, not filtered afterwards: --exclude-dir exists to avoid
          // descending into node_modules, and filtering later would still read every file in it.
          if (excludeDirGlobs.some((re) => re.test(entry.name))) continue;
          result.push(...walkDir(fullPath));
        }
      }
    } catch {
      // skip inaccessible dirs
    }
    return result;
  }

  if (files.length === 0) {
    if (ctx.stdin) {
      const content = await ctx.stdin.readAll();
      const lines = content.replace(/\n$/, '').split('\n');
      await grepLines(lines, null);
    } else {
      ctx.stderr.write('grep: missing file operand\n');
      return 2;
    }
  } else {
    for (const file of files) {
      const path = resolve(ctx.cwd, file);
      try {
        const stat = ctx.vfs.stat(path);
        if (stat.type === 'directory') {
          if (recursive) {
            const dirFiles = walkDir(path);
            for (const f of dirFiles) {
              try {
                if (!fileIsSearchable(f)) {
                  continue;
                }
                if (isBinaryMime(getMimeType(f))) {
                  continue;
                }
                const content = ctx.vfs.readFileString(f);
                const lines = content.replace(/\n$/, '').split('\n');
                await grepLines(lines, f);
              } catch {
                // skip unreadable files
              }
            }
          } else {
            ctx.stderr.write(`grep: ${file}: Is a directory\n`);
          }
          continue;
        }
        if (!fileIsSearchable(path)) {
          continue;
        }
        if (isBinaryMime(getMimeType(path))) {
          ctx.stderr.write(`grep: ${file}: binary file, skipping\n`);
          continue;
        }
        const content = ctx.vfs.readFileString(path);
        const lines = content.replace(/\n$/, '').split('\n');
        await grepLines(lines, multiFile ? file : null);
      } catch (e) {
        if (e instanceof VFSError) {
          ctx.stderr.write(`grep: ${file}: ${e.message}\n`);
        } else {
          throw e;
        }
      }
    }
  }

  return matched ? 0 : 1;
};

export default command;
