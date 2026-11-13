import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VFS, VFSError, SqliteMountProvider, nodeSqlite } from '../../src/kernel/vfs/index.js';
import { exportVfsSnapshot, importVfsSnapshot } from '../../src/kernel/vfs/snapshot.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

const dirs: string[] = [];
const dbFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'lifo-sqlite-mount-'));
  dirs.push(d);
  return join(d, 'box.db');
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tick = () => new Promise<void>((r) => setImmediate(r));
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as VFSError).code;
  }
  return undefined;
};

function open(file = ':memory:', opts?: { chunkSize?: number }) {
  const db = new DatabaseSync(file);
  const sql = nodeSqlite(db);
  return { db, sql, p: new SqliteMountProvider(sql, opts) };
}

describe('SqliteMountProvider', () => {
  it('files and directories: CRUD, readdir, errors', () => {
    const { p } = open();
    p.mkdir('/a/b', { recursive: true });
    p.writeFile('/a/b/f.txt', 'hello');
    expect(p.readFileString('/a/b/f.txt')).toBe('hello');
    expect(p.exists('/a/b/f.txt')).toBe(true);
    expect(p.stat('/a/b/f.txt')).toMatchObject({ type: 'file', size: 5, mode: 0o644 });
    expect(p.stat('/a').type).toBe('directory');
    expect(p.readdir('/a/b')).toEqual([{ name: 'f.txt', type: 'file' }]);
    expect(p.readdir('/').map((d) => d.name)).toEqual(['a']);

    p.writeFile('/a/b/f.txt', 'bye'); // overwrite keeps mode and ctime
    expect(p.readFileString('/a/b/f.txt')).toBe('bye');

    expect(code(() => p.writeFile('/nope/x', '1'))).toBe('ENOENT');
    expect(code(() => p.writeFile('/a/b/f.txt/x', '1'))).toBe('ENOTDIR');
    expect(code(() => p.writeFile('/a', '1'))).toBe('EISDIR');
    expect(code(() => p.readFile('/a'))).toBe('EISDIR');
    expect(code(() => p.mkdir('/a'))).toBe('EEXIST');
    expect(code(() => p.rmdir('/a'))).toBe('ENOTEMPTY');
    expect(code(() => p.unlink('/a'))).toBe('EISDIR');

    p.appendFile('/a/b/f.txt', '!');
    expect(p.readFileString('/a/b/f.txt')).toBe('bye!');
    p.copyFile('/a/b/f.txt', '/a/copy.txt');
    expect(p.readFileString('/a/copy.txt')).toBe('bye!');

    p.unlink('/a/b/f.txt');
    p.rmdir('/a/b');
    expect(p.exists('/a/b')).toBe(false);
    expect(code(() => p.rmdir('/'))).toBe('EINVAL');
  });

  it('rename: files, directories with everything under them, replacing, and into itself', () => {
    const { p } = open();
    p.mkdir('/src/deep/er', { recursive: true });
    p.writeFile('/src/deep/er/f', 'f');
    p.writeFile('/src/top', 't');
    p.rename('/src', '/dst');
    expect(p.exists('/src')).toBe(false);
    expect(p.readFileString('/dst/deep/er/f')).toBe('f');
    expect(p.readdir('/dst').map((d) => d.name).sort()).toEqual(['deep', 'top']);
    expect(p.readdir('/dst/deep/er')).toEqual([{ name: 'f', type: 'file' }]);

    // A sibling whose name shares the prefix is left alone.
    p.mkdir('/ab');
    p.writeFile('/ab/x', 'x');
    p.mkdir('/a');
    p.writeFile('/a/y', 'y');
    p.rename('/a', '/c');
    expect(p.readFileString('/ab/x')).toBe('x');
    expect(p.readFileString('/c/y')).toBe('y');

    p.writeFile('/one', '1');
    p.writeFile('/two', '2');
    p.rename('/one', '/two');
    expect(p.readFileString('/two')).toBe('1');
    expect(code(() => p.rename('/dst', '/dst/deep/inside'))).toBe('EINVAL');
    expect(code(() => p.rename('/two', '/dst'))).toBe('EISDIR');
  });

  it('symlinks, chmod and utimes', () => {
    const { p } = open();
    expect(p.hasSymlinks()).toBe(false);
    p.writeFile('/t', 'x');
    p.symlink('/t', '/l');
    expect(p.hasSymlinks()).toBe(true);
    expect(p.readlink('/l')).toBe('/t');
    expect(p.lstat('/l').type).toBe('symlink');
    expect(p.readdir('/').find((d) => d.name === 'l')?.type).toBe('symlink');
    expect(code(() => p.readlink('/t'))).toBe('EINVAL');
    expect(code(() => p.symlink('/t', '/l'))).toBe('EEXIST');
    p.unlink('/l');
    expect(p.hasSymlinks()).toBe(false);

    p.chmod('/t', 0o755);
    p.utimes('/t', 1_234_000);
    expect(p.stat('/t')).toMatchObject({ mode: 0o755, mtime: 1_234_000 });
    p.writeFile('/t', 'y'); // content changes keep the mode
    expect(p.stat('/t').mode).toBe(0o755);
  });

  it('large files are chunked, shared and collected', () => {
    const { p, sql } = open(':memory:', { chunkSize: 1024 });
    const big = new Uint8Array(5000).map((_, i) => i % 251);
    p.writeFile('/big', big);
    expect(p.stat('/big').size).toBe(5000);
    expect(p.readFile('/big')).toEqual(big);
    const count = (t: string) => Number(sql.exec(`SELECT count(*) AS n FROM ${t}`).toArray()[0].n);
    expect(count('file_chunks')).toBe(5);

    p.copyFile('/big', '/big2'); // same content: chunks are shared
    const chunksAfterCopy = count('chunks');
    expect(count('file_chunks')).toBe(10);
    expect(chunksAfterCopy).toBe(5);

    p.rename('/big2', '/moved');
    expect(p.readFile('/moved')).toEqual(big);
    p.unlink('/big');
    expect(count('chunks')).toBe(5); // still used by /moved
    p.writeFile('/moved', 'small now');
    expect(count('chunks')).toBe(0);
    expect(count('file_chunks')).toBe(0);
    expect(p.readFileString('/moved')).toBe('small now');

    const mixed = new Uint8Array(3000).fill(7);
    p.writeFile('/m', mixed);
    p.appendFile('/m', new Uint8Array(100).fill(8));
    const read = p.readFile('/m');
    expect(read.byteLength).toBe(3100);
    expect(read[2999]).toBe(7);
    expect(read[3000]).toBe(8);
  });

  it('keeps everything in the database: a new provider over the same file sees it', async () => {
    const file = dbFile();
    const a = open(file, { chunkSize: 1024 });
    a.p.mkdir('/home/user', { recursive: true });
    a.p.writeFile('/home/user/notes.md', '# notes');
    a.p.writeFile('/home/user/big.bin', new Uint8Array(4000).fill(9));
    a.p.symlink('notes.md', '/home/user/readme');
    a.p.chmod('/home/user/notes.md', 0o600);
    await tick(); // the turn ends: its writes commit
    a.db.close();

    const b = open(file, { chunkSize: 1024 });
    expect(b.p.readFileString('/home/user/notes.md')).toBe('# notes');
    expect(b.p.readFile('/home/user/big.bin').every((x) => x === 9)).toBe(true);
    expect(b.p.readlink('/home/user/readme')).toBe('notes.md');
    expect(b.p.hasSymlinks()).toBe(true);
    expect(b.p.stat('/home/user/notes.md').mode).toBe(0o600);
    b.db.close();
  });

  it('commits per event-loop turn: a crash loses only the turn in progress', async () => {
    const file = dbFile();
    const writer = open(file);
    writer.p.writeFile('/done', 'committed');
    await tick();

    writer.p.writeFile('/inflight', 'not yet');
    writer.p.writeFile('/done', 'changed in the same turn');
    // Another connection (as after a crash) sees only finished turns.
    const reader = new SqliteMountProvider(nodeSqlite(new DatabaseSync(file)));
    expect(reader.readFileString('/done')).toBe('committed');
    expect(reader.exists('/inflight')).toBe(false);

    // The process dies before the turn ends: the open transaction never commits.
    writer.db.close();
    const after = new SqliteMountProvider(nodeSqlite(new DatabaseSync(file)));
    expect(after.readFileString('/done')).toBe('committed');
    expect(after.exists('/inflight')).toBe(false);

    // flush() commits without waiting for the turn to end.
    const again = open(file);
    again.p.writeFile('/flushed', 'now');
    again.p.flush();
    expect(new SqliteMountProvider(nodeSqlite(new DatabaseSync(file))).readFileString('/flushed')).toBe('now');
    again.db.close();
  });
});

describe('a VFS with a SQLite mount', () => {
  it('routes every operation, emits change events, and follows links in and out of the mount', () => {
    const vfs = new VFS();
    vfs.mkdir('/home', { recursive: true });
    const { p } = open();
    vfs.mount('/home', p);
    const events: string[] = [];
    vfs.watch((e) => events.push(`${e.type}:${e.path}`));

    vfs.mkdir('/home/user/app', { recursive: true });
    vfs.writeFile('/home/user/app/a.txt', 'a');
    vfs.appendFile('/home/user/app/a.txt', 'b');
    vfs.touch('/home/user/app/a.txt');
    expect(vfs.readFileString('/home/user/app/a.txt')).toBe('ab'); // touch didn't truncate
    vfs.chmod('/home/user/app/a.txt', 0o700);
    expect(vfs.stat('/home/user/app/a.txt').mode).toBe(0o700);

    vfs.writeFile('/etc-in-tree.txt', 'tree');
    vfs.symlink('/etc-in-tree.txt', '/home/user/out'); // mount -> tree
    vfs.symlink('/home/user/app', '/app'); // tree -> mount
    expect(vfs.readFileString('/home/user/out')).toBe('tree');
    expect(vfs.readFileString('/app/a.txt')).toBe('ab');
    expect(vfs.realpath('/app/a.txt')).toBe('/home/user/app/a.txt');

    vfs.rename('/home/user/app', '/home/user/app2');
    expect(vfs.readFileString('/home/user/app2/a.txt')).toBe('ab');
    vfs.rmdirRecursive('/home/user/app2');
    expect(vfs.exists('/home/user/app2')).toBe(false);

    expect(events).toEqual(
      expect.arrayContaining([
        'create:/home/user/app',
        'create:/home/user/app/a.txt',
        'modify:/home/user/app/a.txt',
        'attrib:/home/user/app/a.txt',
        'create:/home/user/out',
        'rename:/home/user/app2',
        'delete:/home/user/app2/a.txt',
        'delete:/home/user/app2',
      ]),
    );
  });

  it('a box with its home on SQLite: shell, node, snapshot export and import', async () => {
    const file = dbFile();
    const box = await Sandbox.create();
    const vfs = box.kernel.vfs;
    // Move the box's /home into the database: snapshot it, mount, restore into the mount.
    const home = await exportVfsSnapshot(vfs, { exclude: ['bin', 'etc', 'usr', 'tmp', 'var', 'root', 'opt', 'srv', 'mnt', 'lib', 'sbin', 'run', 'sys', 'media', 'boot'] });
    const db = new DatabaseSync(file);
    vfs.mount('/home', new SqliteMountProvider(nodeSqlite(db)));
    await importVfsSnapshot(vfs, home);
    expect(vfs.exists('/home/user')).toBe(true);

    const r = await box.commands.run(
      [
        'cd /home/user && mkdir -p proj/src && cd proj',
        'echo "console.log(require(\'./src/lib\').n * 2)" > main.js',
        'echo "module.exports = { n: 21 }" > src/lib.js',
        'node main.js',
        'ln -s main.js entry.js && node entry.js',
        'node -e "require(\'fs\').writeFileSync(\'out.json\', JSON.stringify({ ok: true }))"',
        'cat out.json',
        'chmod 755 main.js && ls -l main.js',
        'mv src lib && ls lib',
      ].join('\n'),
      { cwd: '/home/user' },
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('42\n42\n');
    expect(r.stdout).toContain('{"ok":true}');
    expect(r.stdout).toMatch(/-rwxr-xr-x.* main\.js/);
    expect(r.stdout).toContain('lib.js');
    await tick();

    // Snapshot of the box includes what's in the mount, link included.
    const snap = await exportVfsSnapshot(vfs);
    box.destroy();
    db.close();

    // The database alone has the files (as after a crash or a move to another node).
    const reopened = new SqliteMountProvider(nodeSqlite(new DatabaseSync(file)));
    expect(reopened.readFileString('/user/proj/out.json')).toBe('{"ok":true}');
    expect(reopened.readlink('/user/proj/entry.js')).toBe('main.js');
    expect(reopened.stat('/user/proj/main.js').mode).toBe(0o755);

    // And the tar.gz restores into a fresh box's SQLite home.
    const fresh = new VFS();
    fresh.mkdir('/home', { recursive: true });
    fresh.mount('/home', new SqliteMountProvider(nodeSqlite(new DatabaseSync(':memory:'))));
    await importVfsSnapshot(fresh, snap);
    expect(fresh.readFileString('/home/user/proj/lib/lib.js')).toContain('n: 21');
    expect(fresh.readlink('/home/user/proj/entry.js')).toBe('main.js');
  }, 60_000);

  it('git init / add / commit in a SQLite home', async (t) => {
    let gitCommand: Parameters<Sandbox['commands']['register']>[1];
    try {
      // Typed against core's dist; the same shape as the source's Command.
      gitCommand = (await import('../../../lifo-pkg-git/dist/index.js')).default as unknown as typeof gitCommand;
    } catch {
      t.skip(); // lifo-pkg-git isn't built in this checkout
      return;
    }
    const box = await Sandbox.create();
    box.commands.register('git', gitCommand);
    box.kernel.vfs.mount('/home', new SqliteMountProvider(nodeSqlite(new DatabaseSync(':memory:'))));
    box.kernel.vfs.mkdir('/home/user/repo', { recursive: true });
    const r = await box.commands.run(
      'git init -q && echo hello > a.txt && git add a.txt && git commit -q -m first && git log --oneline && git status --short',
      { cwd: '/home/user/repo' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/first/);
    expect(box.kernel.vfs.exists('/home/user/repo/.git/HEAD')).toBe(true);
    box.destroy();
  }, 60_000);
});
