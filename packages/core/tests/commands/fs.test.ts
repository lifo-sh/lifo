import { describe, it, expect, beforeEach } from 'vitest';
import { VFS, VFSError } from '../../src/kernel/vfs/index.js';
import type { CommandContext, CommandOutputStream } from '../../src/commands/types.js';

// Helper to create a command context
function createContext(vfs: VFS, args: string[], cwd = '/'): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  return {
    args,
    env: { HOME: '/home/user', USER: 'user' },
    cwd,
    vfs,
    stdout,
    stderr,
    signal: new AbortController().signal,
  };
}

describe('ls', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/test');
    vfs.writeFile('/test/a.txt', 'hello');
    vfs.writeFile('/test/b.txt', 'world');
    vfs.mkdir('/test/subdir');
  });

  it('lists files in current directory', async () => {
    const { default: ls } = await import('../../src/commands/fs/ls.js');
    const ctx = createContext(vfs, [], '/test');
    const code = await ls(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('a.txt');
    expect(ctx.stdout.text).toContain('b.txt');
    expect(ctx.stdout.text).toContain('subdir');
  });

  it('lists files in specified directory', async () => {
    const { default: ls } = await import('../../src/commands/fs/ls.js');
    const ctx = createContext(vfs, ['/test'], '/');
    const code = await ls(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('a.txt');
  });

  it('long format with -l', async () => {
    const { default: ls } = await import('../../src/commands/fs/ls.js');
    const ctx = createContext(vfs, ['-l'], '/test');
    const code = await ls(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('user');
    expect(ctx.stdout.text).toContain('a.txt');
  });

  it('shows hidden files with -a', async () => {
    vfs.writeFile('/test/.hidden', 'secret');
    const { default: ls } = await import('../../src/commands/fs/ls.js');
    const ctx = createContext(vfs, ['-a'], '/test');
    const code = await ls(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('.hidden');
  });

  it('errors on non-existent directory', async () => {
    const { default: ls } = await import('../../src/commands/fs/ls.js');
    const ctx = createContext(vfs, ['/nonexistent'], '/');
    const code = await ls(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('ENOENT');
  });
});

describe('cat', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/hello.txt', 'Hello, World!\n');
  });

  it('reads file contents', async () => {
    const { default: cat } = await import('../../src/commands/fs/cat.js');
    const ctx = createContext(vfs, ['/hello.txt']);
    const code = await cat(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('Hello, World!\n');
  });

  it('errors on missing file', async () => {
    const { default: cat } = await import('../../src/commands/fs/cat.js');
    const ctx = createContext(vfs, ['/nope.txt']);
    const code = await cat(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr.text).toContain('ENOENT');
  });

  it('errors with no args', async () => {
    const { default: cat } = await import('../../src/commands/fs/cat.js');
    const ctx = createContext(vfs, []);
    const code = await cat(ctx);
    expect(code).toBe(1);
  });
});

describe('mkdir', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
  });

  it('creates a directory', async () => {
    const { default: mkdir } = await import('../../src/commands/fs/mkdir.js');
    const ctx = createContext(vfs, ['/newdir']);
    const code = await mkdir(ctx);
    expect(code).toBe(0);
    expect(vfs.stat('/newdir').type).toBe('directory');
  });

  it('creates nested dirs with -p', async () => {
    const { default: mkdir } = await import('../../src/commands/fs/mkdir.js');
    const ctx = createContext(vfs, ['-p', '/a/b/c']);
    const code = await mkdir(ctx);
    expect(code).toBe(0);
    expect(vfs.stat('/a/b/c').type).toBe('directory');
  });

  it('errors without -p for nested', async () => {
    const { default: mkdir } = await import('../../src/commands/fs/mkdir.js');
    const ctx = createContext(vfs, ['/a/b']);
    const code = await mkdir(ctx);
    expect(code).toBe(1);
  });
});

describe('rm', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/file.txt', 'data');
    vfs.mkdir('/dir');
    vfs.writeFile('/dir/inner.txt', 'inner');
  });

  it('removes a file', async () => {
    const { default: rm } = await import('../../src/commands/fs/rm.js');
    const ctx = createContext(vfs, ['/file.txt']);
    const code = await rm(ctx);
    expect(code).toBe(0);
    expect(vfs.exists('/file.txt')).toBe(false);
  });

  it('errors on dir without -r', async () => {
    const { default: rm } = await import('../../src/commands/fs/rm.js');
    const ctx = createContext(vfs, ['/dir']);
    const code = await rm(ctx);
    expect(code).toBe(1);
    expect(vfs.exists('/dir')).toBe(true);
  });

  it('removes dir recursively with -r', async () => {
    const { default: rm } = await import('../../src/commands/fs/rm.js');
    const ctx = createContext(vfs, ['-r', '/dir']);
    const code = await rm(ctx);
    expect(code).toBe(0);
    expect(vfs.exists('/dir')).toBe(false);
  });

  it('force flag suppresses errors', async () => {
    const { default: rm } = await import('../../src/commands/fs/rm.js');
    const ctx = createContext(vfs, ['-f', '/nonexistent']);
    const code = await rm(ctx);
    expect(code).toBe(0);
  });
});

describe('cp', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/src.txt', 'content');
    vfs.mkdir('/dest');
  });

  it('copies a file', async () => {
    const { default: cp } = await import('../../src/commands/fs/cp.js');
    const ctx = createContext(vfs, ['/src.txt', '/copy.txt']);
    const code = await cp(ctx);
    expect(code).toBe(0);
    expect(vfs.readFileString('/copy.txt')).toBe('content');
  });

  it('copies into directory', async () => {
    const { default: cp } = await import('../../src/commands/fs/cp.js');
    const ctx = createContext(vfs, ['/src.txt', '/dest']);
    const code = await cp(ctx);
    expect(code).toBe(0);
    expect(vfs.readFileString('/dest/src.txt')).toBe('content');
  });
});

describe('mv', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/src.txt', 'content');
    vfs.mkdir('/dest');
  });

  it('moves a file', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['/src.txt', '/moved.txt']);
    const code = await mv(ctx);
    expect(code).toBe(0);
    expect(vfs.exists('/src.txt')).toBe(false);
    expect(vfs.readFileString('/moved.txt')).toBe('content');
  });

  it('moves into directory', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['/src.txt', '/dest']);
    const code = await mv(ctx);
    expect(code).toBe(0);
    expect(vfs.exists('/src.txt')).toBe(false);
    expect(vfs.readFileString('/dest/src.txt')).toBe('content');
  });
});

describe('mv with several sources and flags', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/app');
    vfs.mkdir('/app/(app)');
    vfs.writeFile('/app/(app)/index.tsx', 'INDEX');
    vfs.writeFile('/app/(app)/coin-flip.tsx', 'COIN');
    vfs.writeFile('/app/(app)/dice.tsx', 'DICE');
    vfs.mkdir('/app/(app)/(tabs)');
  });

  // RapidNative escalation 2026-11-16: only args[0] and args[1] were read, so this renamed index.tsx
  // onto coin-flip.tsx, ignored the rest, exited 0, and the agent then deleted the folder it thought was empty.
  it('moves every source into the directory', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['index.tsx', 'coin-flip.tsx', 'dice.tsx', '(tabs)/'], '/app/(app)');
    expect(await mv(ctx)).toBe(0);
    expect(vfs.readFileString('/app/(app)/(tabs)/index.tsx')).toBe('INDEX');
    expect(vfs.readFileString('/app/(app)/(tabs)/coin-flip.tsx')).toBe('COIN');
    expect(vfs.readFileString('/app/(app)/(tabs)/dice.tsx')).toBe('DICE');
    expect(vfs.exists('/app/(app)/index.tsx')).toBe(false);
  });

  it('refuses several sources when the target is not a directory, changing nothing', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['index.tsx', 'coin-flip.tsx', 'dice.tsx'], '/app/(app)');
    expect(await mv(ctx)).toBe(1);
    expect(ctx.stderr.text).toContain("target 'dice.tsx' is not a directory");
    expect(vfs.readFileString('/app/(app)/coin-flip.tsx')).toBe('COIN');
    expect(vfs.readFileString('/app/(app)/index.tsx')).toBe('INDEX');
  });

  it('reads flags as flags, not file names', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['-fv', 'index.tsx', 'home.tsx'], '/app/(app)');
    expect(await mv(ctx)).toBe(0);
    expect(vfs.readFileString('/app/(app)/home.tsx')).toBe('INDEX');
    expect(ctx.stdout.text).toContain('renamed');
    const n = createContext(vfs, ['-n', 'dice.tsx', 'coin-flip.tsx'], '/app/(app)');
    expect(await mv(n)).toBe(0);
    expect(vfs.readFileString('/app/(app)/coin-flip.tsx')).toBe('COIN');
    expect(vfs.exists('/app/(app)/dice.tsx')).toBe(true);
  });

  it('fails on a missing source but still moves the others', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['nope.tsx', 'dice.tsx', '(tabs)'], '/app/(app)');
    expect(await mv(ctx)).toBe(1);
    expect(ctx.stderr.text).toContain("cannot stat 'nope.tsx'");
    expect(vfs.exists('/app/(app)/(tabs)/dice.tsx')).toBe(true);
  });

  it('keeps the existing file when the move fails', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const real = vfs.rename.bind(vfs);
    vfs.rename = () => {
      throw new VFSError('EINVAL' as any, 'cannot rename across mount boundaries');
    };
    const ctx = createContext(vfs, ['dice.tsx', 'coin-flip.tsx'], '/app/(app)');
    expect(await mv(ctx)).toBe(1);
    vfs.rename = real;
    expect(vfs.readFileString('/app/(app)/coin-flip.tsx')).toBe('COIN');
    expect(vfs.readFileString('/app/(app)/dice.tsx')).toBe('DICE');
  });

  it('replaces an existing file, and moves a directory into an existing one', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    expect(await mv(createContext(vfs, ['dice.tsx', 'coin-flip.tsx'], '/app/(app)'))).toBe(0);
    expect(vfs.readFileString('/app/(app)/coin-flip.tsx')).toBe('DICE');
    vfs.mkdir('/empty');
    vfs.mkdir('/full');
    vfs.writeFile('/full/x', 'X');
    expect(await mv(createContext(vfs, ['/full', '/empty']))).toBe(0);
    expect(vfs.readFileString('/empty/full/x')).toBe('X');
  });

  it('will not move a directory into itself', async () => {
    const { default: mv } = await import('../../src/commands/fs/mv.js');
    const ctx = createContext(vfs, ['/app/(app)', '/app/(app)/(tabs)']);
    expect(await mv(ctx)).toBe(1);
    expect(vfs.exists('/app/(app)/index.tsx')).toBe(true);
  });
});

describe('cp with several sources and -r', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/src');
    vfs.writeFile('/src/a.txt', 'A');
    vfs.mkdir('/src/sub');
    vfs.writeFile('/src/sub/b.txt', 'B');
    vfs.writeFile('/one.txt', '1');
    vfs.writeFile('/two.txt', '2');
    vfs.mkdir('/out');
  });

  it('copies every source into the directory', async () => {
    const { default: cp } = await import('../../src/commands/fs/cp.js');
    const ctx = createContext(vfs, ['/one.txt', '/two.txt', '/out']);
    expect(await cp(ctx)).toBe(0);
    expect(vfs.readFileString('/out/one.txt')).toBe('1');
    expect(vfs.readFileString('/out/two.txt')).toBe('2');
  });

  it('copies a directory tree with -r, and refuses one without it', async () => {
    const { default: cp } = await import('../../src/commands/fs/cp.js');
    const without = createContext(vfs, ['/src', '/copy']);
    expect(await cp(without)).toBe(1);
    expect(without.stderr.text).toContain('-r not specified');
    expect(vfs.exists('/copy')).toBe(false);
    const ctx = createContext(vfs, ['-r', '/src', '/copy']);
    expect(await cp(ctx)).toBe(0);
    expect(vfs.readFileString('/copy/a.txt')).toBe('A');
    expect(vfs.readFileString('/copy/sub/b.txt')).toBe('B');
    const into = createContext(vfs, ['-R', '/src', '/out']);
    expect(await cp(into)).toBe(0);
    expect(vfs.readFileString('/out/src/sub/b.txt')).toBe('B');
  });

  it('refuses several sources when the target is not a directory', async () => {
    const { default: cp } = await import('../../src/commands/fs/cp.js');
    const ctx = createContext(vfs, ['/one.txt', '/two.txt', '/three.txt']);
    expect(await cp(ctx)).toBe(1);
    expect(vfs.exists('/three.txt')).toBe(false);
  });
});

describe('touch', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
  });

  it('creates new file', async () => {
    const { default: touch } = await import('../../src/commands/fs/touch.js');
    const ctx = createContext(vfs, ['/newfile']);
    const code = await touch(ctx);
    expect(code).toBe(0);
    expect(vfs.exists('/newfile')).toBe(true);
    expect(vfs.readFileString('/newfile')).toBe('');
  });

  it('updates mtime on existing', async () => {
    vfs.writeFile('/f', 'data');
    const before = vfs.stat('/f').mtime;
    const { default: touch } = await import('../../src/commands/fs/touch.js');
    const ctx = createContext(vfs, ['/f']);
    const code = await touch(ctx);
    expect(code).toBe(0);
    expect(vfs.stat('/f').mtime).toBeGreaterThanOrEqual(before);
    expect(vfs.readFileString('/f')).toBe('data'); // content preserved
  });
});
