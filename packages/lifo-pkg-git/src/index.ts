import type { Command, CommandContext, VFS } from '@lifo-sh/core';
import { Buffer, resolve, dirname } from '@lifo-sh/core';
import type { HttpClient } from 'isomorphic-git';

// isomorphic-git checks `typeof Buffer` at module load time.
// Polyfill it on globalThis before the dynamic import.
if (typeof (globalThis as unknown as Record<string, unknown>).Buffer === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).Buffer = Buffer;
}

type Git = typeof import('isomorphic-git').default;
let _git: Git;
async function loadGit(): Promise<Git> {
  if (!_git) {
    const mod = await import('isomorphic-git');
    _git = mod.default;
  }
  return _git;
}

// ─── VFS → isomorphic-git fs adapter ───

function createGitFs(vfs: VFS) {
  interface NodeStat {
    type: 'file' | 'directory';
    mode: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    ino: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }

  function toStat(path: string): NodeStat {
    const s = vfs.stat(path);
    // isomorphic-git expects full POSIX mode with file type bits in upper nibble:
    // 0o100644 (regular file) or 0o040000 (directory)
    // VFS stores only permission bits (0o644, 0o755), so we add the type prefix.
    const mode = s.type === 'directory'
      ? 0o040000
      : (s.mode & 0o777) | 0o100000;
    return {
      type: s.type,
      mode,
      size: s.size,
      mtimeMs: s.mtime,
      ctimeMs: s.ctime,
      uid: 1000,
      gid: 1000,
      ino: 0,
      dev: 0,
      isFile: () => s.type === 'file',
      isDirectory: () => s.type === 'directory',
      isSymbolicLink: () => false,
    };
  }

  function ensureParentDirs(filePath: string): void {
    const dir = dirname(filePath);
    if (dir === '/' || dir === '.') return;
    if (!vfs.exists(dir)) {
      ensureParentDirs(dir);
      vfs.mkdir(dir);
    }
  }

  const promises = {
    async readFile(path: string, options?: { encoding?: string } | string) {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return vfs.readFileString(path);
      }
      // Return Buffer (not plain Uint8Array) so isomorphic-git can call
      // Buffer methods like .toString('hex'), .readUInt32BE(), etc.
      return Buffer.from(vfs.readFile(path));
    },
    async writeFile(path: string, data: string | Uint8Array, _options?: { mode?: number; encoding?: string } | string) {
      ensureParentDirs(path);
      // Copy the buffer - isomorphic-git reuses/mutates buffers after writing,
      // and VFS stores Uint8Array by reference.
      const safe = typeof data === 'string' ? data : new Uint8Array(data);
      vfs.writeFile(path, safe);
    },
    async unlink(path: string) {
      vfs.unlink(path);
    },
    async readdir(path: string) {
      return vfs.readdir(path).map((e) => e.name);
    },
    async mkdir(path: string, options?: { recursive?: boolean }) {
      if (options?.recursive) {
        vfs.mkdir(path, { recursive: true });
      } else {
        vfs.mkdir(path);
      }
    },
    async rmdir(path: string) {
      vfs.rmdir(path);
    },
    async stat(path: string) {
      return toStat(path);
    },
    async lstat(path: string) {
      return toStat(path);
    },
    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`ENOENT: readlink '${path}'`), { code: 'ENOENT' });
    },
    async symlink(_target: string, _path: string): Promise<void> {
      // no-op: VFS has no symlinks
    },
    async chmod(_path: string, _mode: number): Promise<void> {
      // no-op
    },
  };

  return { promises };
}

type GitFs = ReturnType<typeof createGitFs>;

// ─── HTTP client for clone/push/fetch ───

function createHttpClient(): HttpClient {
  return {
    async request({ url, method, headers, body }) {
      let bodyBytes: Uint8Array | undefined;
      if (body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of body) {
          chunks.push(chunk);
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        bodyBytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.length;
        }
      }

      const res = await fetch(url, {
        method: method || 'GET',
        headers,
        body: bodyBytes as unknown as BodyInit,
      });

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const responseBody = new Uint8Array(await res.arrayBuffer());

      async function* bodyIterator() {
        yield responseBody;
      }

      return {
        url: res.url,
        method: method || 'GET',
        headers: responseHeaders,
        body: bodyIterator(),
        statusCode: res.status,
        statusMessage: res.statusText,
      };
    },
  };
}

// ─── Helpers ───

function findGitRoot(vfs: VFS, cwd: string): string | null {
  let dir = resolve('/', cwd);
  while (true) {
    if (vfs.exists(dir + '/.git') || vfs.exists(dir + '/.git/HEAD')) {
      return dir;
    }
    if (dir === '/') return null;
    dir = dirname(dir);
  }
}

const USAGE = `usage: git <command> [<args>]

Commands:
  init        Create an empty Git repository
  clone       Clone a repository
  add         Add file contents to the index
  commit      Record changes to the repository
  status      Show the working tree status
  log         Show commit logs
  branch      List, create, or delete branches
  checkout    Switch branches or restore files
  diff        Show changes between commits
  remote      Manage remote repositories
  push        Update remote refs along with objects
  pull        Fetch from and integrate with a remote
  fetch       Download objects and refs from a remote
`;

// ─── Subcommands ───

async function gitInit(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = ctx.args[0] ? resolve(ctx.cwd, ctx.args[0]) : ctx.cwd;
  await git.init({ fs, dir });
  ctx.stdout.write(`Initialized empty Git repository in ${dir}/.git/\n`);
  return 0;
}

async function gitClone(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const url = ctx.args[0];
  if (!url) {
    ctx.stderr.write('fatal: You must specify a repository to clone.\n');
    return 128;
  }

  let dir = ctx.args[1];
  if (!dir) {
    const urlParts = url.replace(/\.git$/, '').split('/');
    dir = urlParts[urlParts.length - 1] || 'repo';
  }
  dir = resolve(ctx.cwd, dir);

  ctx.stdout.write(`Cloning into '${dir}'...\n`);

  try {
    await git.clone({
      fs,
      http: createHttpClient(),
      // Route through a git CORS proxy in the browser (git hosts don't send CORS
      // headers). Set by the playground to a dedicated proxy so heavy pack data
      // never hits our own /_cors. Undefined in Node → direct fetch.
      corsProxy: ctx.env.LIFO_GIT_CORS_PROXY || undefined,
      dir,
      url,
      singleBranch: true,
      depth: 1,
    });
    ctx.stdout.write('done.\n');
    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    return 128;
  }
}

async function gitAdd(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  if (ctx.args.length === 0) {
    ctx.stderr.write('Nothing specified, nothing added.\n');
    return 1;
  }

  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  for (const pattern of ctx.args) {
    if (pattern === '.') {
      await addAllFiles(git, ctx.vfs, fs, dir, ctx.cwd);
    } else {
      const filepath = resolveRelativeToRepo(ctx.cwd, dir, pattern);
      try {
        if (ctx.vfs.exists(resolve(dir, filepath))) {
          const s = ctx.vfs.stat(resolve(dir, filepath));
          if (s.type === 'directory') {
            await addAllFiles(git, ctx.vfs, fs, dir, resolve(dir, filepath));
          } else {
            await git.add({ fs, dir, filepath });
          }
        } else {
          await git.remove({ fs, dir, filepath });
        }
      } catch (e: unknown) {
        ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        return 128;
      }
    }
  }

  return 0;
}

async function addAllFiles(git: Git, vfs: VFS, fs: GitFs, dir: string, targetDir: string): Promise<void> {
  const entries = vfs.readdir(targetDir);
  for (const entry of entries) {
    const fullPath = targetDir + '/' + entry.name;
    if (entry.name === '.git') continue;
    if (entry.type === 'directory') {
      await addAllFiles(git, vfs, fs, dir, fullPath);
    } else {
      const rel = fullPath.slice(dir.length + 1);
      await git.add({ fs, dir, filepath: rel });
    }
  }
}

function resolveRelativeToRepo(cwd: string, repoRoot: string, path: string): string {
  const abs = resolve(cwd, path);
  if (abs.startsWith(repoRoot + '/')) {
    return abs.slice(repoRoot.length + 1);
  }
  return abs.startsWith('/') ? abs.slice(1) : abs;
}

async function gitCommit(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;
  let message: string | undefined;

  for (let i = 0; i < ctx.args.length; i++) {
    if ((ctx.args[i] === '-m' || ctx.args[i] === '--message') && ctx.args[i + 1]) {
      message = ctx.args[i + 1];
      break;
    }
  }

  if (!message) {
    ctx.stderr.write('error: switch `m\' requires a value\n');
    return 1;
  }

  try {
    const sha = await git.commit({
      fs,
      dir,
      message,
      author: {
        name: ctx.env.GIT_AUTHOR_NAME || ctx.env.USER || 'user',
        email: ctx.env.GIT_AUTHOR_EMAIL || 'user@lifo.sh',
      },
    });
    const short = sha.slice(0, 7);
    ctx.stdout.write(`[${short}] ${message}\n`);
    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

async function gitStatus(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  try {
    const currentBranch = await git.currentBranch({ fs, dir }) || 'HEAD';
    ctx.stdout.write(`On branch ${currentBranch}\n`);

    const matrix = await git.statusMatrix({ fs, dir });

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const [filepath, head, workdir, index] of matrix) {
      // isomorphic-git statusMatrix values:
      // HEAD: 0=absent, 1=present
      // WORKDIR: 0=absent, 1=identical to index, 2=different from index
      // STAGE: 0=absent, 1=identical to HEAD, 2=different from HEAD, 3=different from both
      if (head === 0 && workdir === 2 && index === 0) {
        untracked.push(filepath as string);
      } else if (head === 0 && index === 2) {
        staged.push(`new file:   ${filepath}`);
      } else if (head === 1 && index === 2) {
        staged.push(`modified:   ${filepath}`);
        if (workdir === 2) {
          unstaged.push(`modified:   ${filepath}`);
        }
      } else if (head === 1 && workdir === 2 && index === 1) {
        unstaged.push(`modified:   ${filepath}`);
      } else if (head === 1 && workdir === 0 && index === 0) {
        staged.push(`deleted:    ${filepath}`);
      } else if (head === 1 && workdir === 0 && index === 1) {
        unstaged.push(`deleted:    ${filepath}`);
      } else if (head === 1 && index === 3) {
        staged.push(`modified:   ${filepath}`);
        if (workdir === 2) {
          unstaged.push(`modified:   ${filepath}`);
        }
      }
    }

    if (staged.length > 0) {
      ctx.stdout.write('\nChanges to be committed:\n');
      ctx.stdout.write('  (use "git restore --staged <file>..." to unstage)\n');
      for (const line of staged) {
        ctx.stdout.write(`\t\x1b[32m${line}\x1b[0m\n`);
      }
    }

    if (unstaged.length > 0) {
      ctx.stdout.write('\nChanges not staged for commit:\n');
      ctx.stdout.write('  (use "git add <file>..." to update what will be committed)\n');
      for (const line of unstaged) {
        ctx.stdout.write(`\t\x1b[31m${line}\x1b[0m\n`);
      }
    }

    if (untracked.length > 0) {
      ctx.stdout.write('\nUntracked files:\n');
      ctx.stdout.write('  (use "git add <file>..." to include in what will be committed)\n');
      for (const file of untracked) {
        ctx.stdout.write(`\t\x1b[31m${file}\x1b[0m\n`);
      }
    }

    if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
      ctx.stdout.write('nothing to commit, working tree clean\n');
    }

    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    return 128;
  }
}

async function gitLog(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  let depth = 10;
  let oneline = false;

  for (let i = 0; i < ctx.args.length; i++) {
    if (ctx.args[i] === '--oneline') {
      oneline = true;
    } else if (ctx.args[i] === '-n' && ctx.args[i + 1]) {
      depth = parseInt(ctx.args[i + 1], 10);
      i++;
    } else if (ctx.args[i].startsWith('-') && !isNaN(parseInt(ctx.args[i].slice(1), 10))) {
      depth = parseInt(ctx.args[i].slice(1), 10);
    }
  }

  try {
    const commits = await git.log({ fs, dir, depth });

    for (const entry of commits) {
      const { oid, commit } = entry;
      const short = oid.slice(0, 7);

      if (oneline) {
        ctx.stdout.write(`\x1b[33m${short}\x1b[0m ${commit.message.split('\n')[0]}\n`);
      } else {
        ctx.stdout.write(`\x1b[33mcommit ${oid}\x1b[0m\n`);
        ctx.stdout.write(`Author: ${commit.author.name} <${commit.author.email}>\n`);
        const date = new Date(commit.author.timestamp * 1000);
        ctx.stdout.write(`Date:   ${date.toUTCString()}\n`);
        ctx.stdout.write(`\n    ${commit.message.trim()}\n\n`);
      }
    }

    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    return 128;
  }
}

async function gitBranch(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  const deleteFlag = ctx.args.includes('-d') || ctx.args.includes('-D');
  const branchArgs = ctx.args.filter((a) => !a.startsWith('-'));

  if (deleteFlag && branchArgs.length > 0) {
    try {
      await git.deleteBranch({ fs, dir, ref: branchArgs[0] });
      ctx.stdout.write(`Deleted branch ${branchArgs[0]}\n`);
      return 0;
    } catch (e: unknown) {
      ctx.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  if (branchArgs.length > 0) {
    try {
      await git.branch({ fs, dir, ref: branchArgs[0] });
      return 0;
    } catch (e: unknown) {
      ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      return 128;
    }
  }

  try {
    const branches = await git.listBranches({ fs, dir });
    const current = await git.currentBranch({ fs, dir });
    for (const b of branches) {
      if (b === current) {
        ctx.stdout.write(`* \x1b[32m${b}\x1b[0m\n`);
      } else {
        ctx.stdout.write(`  ${b}\n`);
      }
    }
    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    return 128;
  }
}

async function gitCheckout(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  const createBranch = ctx.args.includes('-b');
  const ref = ctx.args.filter((a) => !a.startsWith('-'))[0];

  if (!ref) {
    ctx.stderr.write('error: you must specify a branch or commit\n');
    return 1;
  }

  try {
    if (createBranch) {
      await git.branch({ fs, dir, ref });
    }
    await git.checkout({ fs, dir, ref });
    ctx.stdout.write(`Switched to branch '${ref}'\n`);
    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

async function gitDiff(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;
  const isStaged = ctx.args.includes('--staged') || ctx.args.includes('--cached');

  try {
    const matrix = await git.statusMatrix({ fs, dir });

    for (const [filepath, head, workdir, index] of matrix) {
      if (isStaged) {
        if ((head === 0 && index === 2) || (head === 1 && index === 2) || (head === 1 && workdir === 0 && index === 0)) {
          ctx.stdout.write(`diff --git a/${filepath} b/${filepath}\n`);
          if (head === 0 && index === 2) {
            ctx.stdout.write(`new file\n`);
            const content = ctx.vfs.readFileString(resolve(dir, filepath as string));
            for (const line of content.split('\n')) {
              ctx.stdout.write(`\x1b[32m+${line}\x1b[0m\n`);
            }
          } else if (workdir === 0 && index === 0) {
            ctx.stdout.write(`deleted file\n`);
          } else {
            ctx.stdout.write(`modified file\n`);
          }
        }
      } else {
        if (workdir === 2 && (index === 1 || index === 3)) {
          ctx.stdout.write(`diff --git a/${filepath} b/${filepath}\n`);
          ctx.stdout.write(`modified file\n`);
        }
      }
    }

    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    return 128;
  }
}

async function gitRemote(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;
  const subcmd = ctx.args[0];

  if (subcmd === 'add' && ctx.args.length >= 3) {
    const name = ctx.args[1];
    const url = ctx.args[2];
    try {
      await git.addRemote({ fs, dir, remote: name, url });
      return 0;
    } catch (e: unknown) {
      ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      return 128;
    }
  }

  if (subcmd === 'remove' && ctx.args.length >= 2) {
    const name = ctx.args[1];
    try {
      await git.deleteRemote({ fs, dir, remote: name });
      return 0;
    } catch (e: unknown) {
      ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      return 128;
    }
  }

  try {
    const verbose = ctx.args.includes('-v') || ctx.args.includes('--verbose');
    const remotes = await git.listRemotes({ fs, dir });
    for (const { remote, url } of remotes) {
      if (verbose) {
        ctx.stdout.write(`${remote}\t${url} (fetch)\n`);
        ctx.stdout.write(`${remote}\t${url} (push)\n`);
      } else {
        ctx.stdout.write(`${remote}\n`);
      }
    }
    return 0;
  } catch (e: unknown) {
    ctx.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    return 128;
  }
}

async function gitPush(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  let remote = 'origin';
  let ref: string | undefined;
  let force = false;
  let setUpstream = false;

  const positional: string[] = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-f' || arg === '--force') {
      force = true;
    } else if (arg === '-u' || arg === '--set-upstream') {
      setUpstream = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 1) remote = positional[0];
  if (positional.length >= 2) ref = positional[1];

  if (!ref) {
    const current = await git.currentBranch({ fs, dir });
    if (!current) {
      ctx.stderr.write('fatal: You are not currently on a branch.\n');
      return 128;
    }
    ref = current;
  }

  const onAuth = createOnAuth(ctx.env);

  try {
    const result = await git.push({
      fs,
      http: createHttpClient(),
      corsProxy: ctx.env.LIFO_GIT_CORS_PROXY || undefined,
      dir,
      remote,
      ref,
      remoteRef: ref,
      force,
      onAuth,
      onMessage(msg: string) { ctx.stderr.write(`remote: ${msg}\n`); },
    });

    if (result.ok) {
      ctx.stdout.write(`To ${await getRemoteUrl(git, fs, dir, remote)}\n`);
      ctx.stdout.write(`   ${ref} -> ${ref}\n`);

      if (setUpstream) {
        // Set upstream tracking
        const configPath = `${dir}/.git/config`;
        try {
          const configContent = ctx.vfs.readFileString(configPath);
          const branchSection = `[branch "${ref}"]\n\tremote = ${remote}\n\tmerge = refs/heads/${ref}\n`;
          if (!configContent.includes(`[branch "${ref}"]`)) {
            ctx.vfs.writeFile(configPath, configContent + '\n' + branchSection);
          }
        } catch {
          // config write is best-effort
        }
      }
    } else {
      ctx.stderr.write('error: failed to push some refs\n');
      if (result.error) ctx.stderr.write(`error: ${result.error}\n`);
      return 1;
    }
    return 0;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('401') || msg.includes('403') || msg.includes('Authentication')) {
      ctx.stderr.write(`fatal: Authentication failed for '${remote}'\n`);
      ctx.stderr.write('hint: Set GIT_TOKEN or GIT_USERNAME/GIT_PASSWORD env vars\n');
    } else {
      ctx.stderr.write(`fatal: ${msg}\n`);
    }
    return 128;
  }
}

async function gitPull(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  let remote: string | undefined;
  let ref: string | undefined;

  const positional: string[] = [];
  for (const arg of ctx.args) {
    if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 1) remote = positional[0];
  if (positional.length >= 2) ref = positional[1];

  const onAuth = createOnAuth(ctx.env);

  const currentBranch = await git.currentBranch({ fs, dir });
  if (!currentBranch) {
    ctx.stderr.write('fatal: You are not currently on a branch.\n');
    return 128;
  }

  const remoteName = remote || 'origin';
  ctx.stdout.write(`Pulling from ${remoteName}...\n`);

  try {
    await git.pull({
      fs,
      http: createHttpClient(),
      corsProxy: ctx.env.LIFO_GIT_CORS_PROXY || undefined,
      dir,
      remote: remoteName,
      ref: ref || currentBranch,
      singleBranch: true,
      fastForward: true,
      fastForwardOnly: false,
      onAuth,
      onMessage(msg: string) { ctx.stderr.write(`remote: ${msg}\n`); },
      author: {
        name: ctx.env.GIT_AUTHOR_NAME || ctx.env.USER || 'user',
        email: ctx.env.GIT_AUTHOR_EMAIL || 'user@lifo.sh',
      },
    });

    ctx.stdout.write('Already up to date.\n');
    return 0;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('401') || msg.includes('403') || msg.includes('Authentication')) {
      ctx.stderr.write(`fatal: Authentication failed for '${remote || 'origin'}'\n`);
      ctx.stderr.write('hint: Set GIT_TOKEN or GIT_USERNAME/GIT_PASSWORD env vars\n');
    } else {
      ctx.stderr.write(`fatal: ${msg}\n`);
    }
    return 128;
  }
}

async function gitFetch(git: Git, ctx: CommandContext, fs: GitFs): Promise<number> {
  const dir = findGitRoot(ctx.vfs, ctx.cwd)!;

  let remote: string | undefined;
  let ref: string | undefined;
  let depth: number | undefined;
  let tags = false;

  const positional: string[] = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '--tags') {
      tags = true;
    } else if (arg === '--depth' && ctx.args[i + 1]) {
      depth = parseInt(ctx.args[i + 1], 10);
      i++;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length >= 1) remote = positional[0];
  if (positional.length >= 2) ref = positional[1];

  const onAuth = createOnAuth(ctx.env);
  const remoteName = remote || 'origin';

  ctx.stdout.write(`Fetching from ${remoteName}...\n`);

  try {
    const result = await git.fetch({
      fs,
      http: createHttpClient(),
      corsProxy: ctx.env.LIFO_GIT_CORS_PROXY || undefined,
      dir,
      remote: remoteName,
      ref,
      singleBranch: !ref,
      tags,
      depth: depth ?? undefined,
      onAuth,
      onMessage(msg: string) { ctx.stderr.write(`remote: ${msg}\n`); },
    });

    if (result.fetchHead) {
      ctx.stdout.write(`From ${await getRemoteUrl(git, fs, dir, remoteName)}\n`);
      if (result.fetchHeadDescription) {
        ctx.stdout.write(` * ${result.fetchHeadDescription}\n`);
      }
    }

    return 0;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('401') || msg.includes('403') || msg.includes('Authentication')) {
      ctx.stderr.write(`fatal: Authentication failed for '${remoteName}'\n`);
      ctx.stderr.write('hint: Set GIT_TOKEN or GIT_USERNAME/GIT_PASSWORD env vars\n');
    } else {
      ctx.stderr.write(`fatal: ${msg}\n`);
    }
    return 128;
  }
}

function createOnAuth(env: Record<string, string>) {
  return () => {
    if (env.GIT_TOKEN) {
      return { username: env.GIT_TOKEN };
    }
    if (env.GIT_USERNAME) {
      return { username: env.GIT_USERNAME, password: env.GIT_PASSWORD || '' };
    }
    return undefined;
  };
}

async function getRemoteUrl(git: Git, fs: GitFs, dir: string, remoteName: string): Promise<string> {
  try {
    const remotes = await git.listRemotes({ fs, dir });
    const r = remotes.find((r) => r.remote === remoteName);
    return r?.url || remoteName;
  } catch {
    return remoteName;
  }
}

// ─── Main entry point ───

const gitCommand: Command = async (ctx) => {
  const subcmd = ctx.args[0];
  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    ctx.stdout.write(USAGE);
    return subcmd ? 0 : 1;
  }

  const git = await loadGit();

  const subCtx: CommandContext = {
    ...ctx,
    args: ctx.args.slice(1),
  };

  const fs = createGitFs(ctx.vfs);

  // Commands that don't require an existing repo
  if (subcmd === 'init') return gitInit(git, subCtx, fs);
  if (subcmd === 'clone') return gitClone(git, subCtx, fs);

  // All other commands require a repo
  const gitRoot = findGitRoot(ctx.vfs, ctx.cwd);
  if (!gitRoot) {
    ctx.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n');
    return 128;
  }

  switch (subcmd) {
    case 'add': return gitAdd(git, subCtx, fs);
    case 'commit': return gitCommit(git, subCtx, fs);
    case 'status': return gitStatus(git, subCtx, fs);
    case 'log': return gitLog(git, subCtx, fs);
    case 'branch': return gitBranch(git, subCtx, fs);
    case 'checkout': return gitCheckout(git, subCtx, fs);
    case 'diff': return gitDiff(git, subCtx, fs);
    case 'remote': return gitRemote(git, subCtx, fs);
    case 'push': return gitPush(git, subCtx, fs);
    case 'pull': return gitPull(git, subCtx, fs);
    case 'fetch': return gitFetch(git, subCtx, fs);
    default:
      ctx.stderr.write(`git: '${subcmd}' is not a git command. See 'git --help'.\n`);
      return 1;
  }
};

export default gitCommand;
