import { describe, it, expect } from 'vitest';
import { VFS, VFSError } from '../../src/kernel/vfs/index.js';
import { serialize, deserialize } from '../../src/kernel/persistence/serializer.js';
import { exportVfsSnapshot, importVfsSnapshot } from '../../src/kernel/vfs/snapshot.js';
import { createTar, parseTar } from '../../src/utils/archive.js';
import { createFs } from '../../src/node-compat/fs.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as VFSError).code;
  }
  return undefined;
};

describe('VFS symlinks', () => {
  it('follows links to files and directories, and lstat/readlink see the link itself', () => {
    const vfs = new VFS();
    vfs.mkdir('/a/b', { recursive: true });
    vfs.writeFile('/a/b/f.txt', 'hello');
    vfs.symlink('b/f.txt', '/a/link'); // relative: resolves from /a
    vfs.symlink('/a/b', '/dir');

    expect(vfs.readFileString('/a/link')).toBe('hello');
    expect(vfs.readFileString('/dir/f.txt')).toBe('hello');
    expect(vfs.readdir('/dir').map((d) => d.name)).toEqual(['f.txt']);
    expect(vfs.stat('/a/link').type).toBe('file');
    expect(vfs.lstat('/a/link').type).toBe('symlink');
    expect(vfs.readlink('/a/link')).toBe('b/f.txt');
    expect(vfs.realpath('/dir/f.txt')).toBe('/a/b/f.txt');
    expect(vfs.readdir('/a').find((d) => d.name === 'link')?.type).toBe('symlink');

    // Writing through a link writes the target.
    vfs.writeFile('/dir/new.txt', 'x');
    expect(vfs.readFileString('/a/b/new.txt')).toBe('x');

    // unlink removes the link, not the target.
    vfs.unlink('/a/link');
    expect(vfs.exists('/a/link')).toBe(false);
    expect(vfs.readFileString('/a/b/f.txt')).toBe('hello');
  });

  it('dangling links, loops and readlink errors', () => {
    const vfs = new VFS();
    vfs.symlink('/nowhere', '/dangling');
    expect(vfs.exists('/dangling')).toBe(false);
    expect(vfs.lstat('/dangling').type).toBe('symlink');
    expect(code(() => vfs.readFile('/dangling'))).toBe('ENOENT');

    vfs.symlink('/loop2', '/loop1');
    vfs.symlink('/loop1', '/loop2');
    expect(code(() => vfs.readFile('/loop1'))).toBe('ELOOP');
    expect(vfs.exists('/loop1')).toBe(false);

    vfs.writeFile('/plain', 'p');
    expect(code(() => vfs.readlink('/plain'))).toBe('EINVAL');
    expect(code(() => vfs.readlink('/missing'))).toBe('ENOENT');
    expect(code(() => vfs.symlink('x', '/plain'))).toBe('EEXIST');
  });

  it('rmdirRecursive removes a link to a directory without touching the directory', () => {
    const vfs = new VFS();
    vfs.mkdir('/keep', { recursive: true });
    vfs.writeFile('/keep/f', '1');
    vfs.symlink('/keep', '/l');
    vfs.rmdirRecursive('/l');
    expect(vfs.exists('/l')).toBe(false);
    expect(vfs.readFileString('/keep/f')).toBe('1');
  });

  it('chmod and utimes change the node and emit attrib events', () => {
    const vfs = new VFS();
    vfs.writeFile('/f', 'x');
    const events: string[] = [];
    vfs.watch((e) => events.push(`${e.type}:${e.path}`));
    vfs.chmod('/f', 0o755);
    vfs.utimes('/f', 1_000_000, 2_000_000);
    expect(vfs.stat('/f').mode).toBe(0o755);
    expect(vfs.stat('/f').mtime).toBe(2_000_000);
    expect(events).toEqual(['attrib:/f', 'attrib:/f']);
  });

  it('survives the persistence serializer and loadFromSerialized', () => {
    const vfs = new VFS();
    vfs.writeFile('/t', 'target');
    vfs.symlink('/t', '/l');
    const copy = new VFS();
    copy.loadFromSerialized(deserialize(serialize(vfs.getRoot())));
    expect(copy.readlink('/l')).toBe('/t');
    expect(copy.readFileString('/l')).toBe('target');
  });

  it('round-trips links, modes and mtimes through tar and snapshots', async () => {
    const long = '/' + 'x'.repeat(150); // over tar's 100-byte linkname field
    const tar = createTar([
      { path: '/a', data: new Uint8Array(0), type: 'file', mode: 0o777, mtime: 0, linkname: 'b' },
      { path: '/c', data: new Uint8Array(0), type: 'file', mode: 0o777, mtime: 0, linkname: long },
    ]);
    const parsed = parseTar(tar);
    expect(parsed.map((e) => [e.path, e.type, e.linkname])).toEqual([['a', 'file', 'b'], ['c', 'file', long]]);

    const vfs = new VFS();
    vfs.mkdir('/home/user/bin', { recursive: true });
    vfs.writeFile('/home/user/bin/run.sh', 'echo hi');
    vfs.chmod('/home/user/bin/run.sh', 0o755);
    vfs.utimes('/home/user/bin/run.sh', 1_700_000_000_000, 1_700_000_000_000);
    vfs.symlink('bin/run.sh', '/home/user/run');
    vfs.symlink('/home/user', '/home/user/self'); // a cycle a naive walk would follow forever

    const snap = await exportVfsSnapshot(vfs);
    const back = new VFS();
    await importVfsSnapshot(back, snap);
    expect(back.readlink('/home/user/run')).toBe('bin/run.sh');
    expect(back.readFileString('/home/user/run')).toBe('echo hi');
    expect(back.readlink('/home/user/self')).toBe('/home/user');
    expect(back.stat('/home/user/bin/run.sh').mode).toBe(0o755);
    expect(back.stat('/home/user/bin/run.sh').mtime).toBe(1_700_000_000_000);
  });
});

describe('node fs on links and attributes', () => {
  it('symlinkSync, readlinkSync, lstatSync, realpathSync, chmodSync, utimesSync', () => {
    const vfs = new VFS();
    vfs.mkdir('/w', { recursive: true });
    const fs = createFs(vfs, '/w') as unknown as typeof import('node:fs');
    fs.writeFileSync('/w/real.txt', 'data');
    fs.symlinkSync('real.txt', '/w/link.txt');
    expect(fs.readlinkSync('/w/link.txt')).toBe('real.txt');
    expect(fs.lstatSync('/w/link.txt').isSymbolicLink()).toBe(true);
    expect(fs.statSync('/w/link.txt').isFile()).toBe(true);
    expect(fs.realpathSync('/w/link.txt')).toBe('/w/real.txt');
    expect(fs.readdirSync('/w', { withFileTypes: true }).find((d) => d.name === 'link.txt')!.isSymbolicLink()).toBe(true);

    fs.chmodSync('/w/real.txt', 0o700);
    expect(fs.statSync('/w/real.txt').mode & 0o777).toBe(0o700);
    fs.utimesSync('/w/real.txt', 1_600_000_000, 1_600_000_000); // seconds, as Node takes numbers
    expect(fs.statSync('/w/real.txt').mtimeMs).toBe(1_600_000_000_000);
    fs.utimesSync('/w/real.txt', new Date(5000), new Date(6000));
    expect(fs.statSync('/w/real.txt').mtimeMs).toBe(6000);

    // rm removes the link, not the target; a dangling link can be removed.
    fs.rmSync('/w/link.txt');
    expect(fs.existsSync('/w/real.txt')).toBe(true);
    fs.symlinkSync('/gone', '/w/dangling');
    fs.rmSync('/w/dangling');
    expect(fs.lstatSync('/w/dangling', { throwIfNoEntry: false })).toBeUndefined();

    let err: NodeJS.ErrnoException | undefined;
    try {
      fs.readlinkSync('/w/real.txt');
    } catch (e) {
      err = e as NodeJS.ErrnoException;
    }
    expect(err?.code).toBe('EINVAL');
  });
});

describe('shell commands', () => {
  it('ln -s, ls -l, chmod, realpath and rm on links', async () => {
    const box = await Sandbox.create();
    const r = await box.commands.run(
      [
        'mkdir -p /tmp/t && cd /tmp/t',
        'echo hi > f.txt',
        'ln -s f.txt l',
        'cat l',
        'ls -l | grep l',
        'chmod 755 f.txt',
        'ls -l f.txt',
        'realpath l',
        'ln -s f.txt l || echo exists',
        'ln -sf f.txt l && echo forced',
        'rm l && ls',
      ].join('\n'),
    );
    expect(r.stdout).toContain('hi\n');
    expect(r.stdout).toMatch(/l[rwx-]{9}.* l -> f\.txt/);
    expect(r.stdout).toMatch(/-rwxr-xr-x.* f\.txt/);
    expect(r.stdout).toContain('/tmp/t/f.txt\n');
    expect(r.stdout).toContain('exists');
    expect(r.stdout).toContain('forced');
    expect(r.stdout.trim().endsWith('f.txt')).toBe(true);
    box.destroy();
  });
});
