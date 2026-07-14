import { describe, it, expect } from 'vitest';
import { serialize, deserialize } from '../../src/kernel/persistence/serializer.js';
import { VFS } from '../../src/kernel/vfs/index.js';

describe('Serializer', () => {
  it('round-trips a VFS tree with files and dirs', () => {
    const vfs = new VFS();
    vfs.mkdir('/home', { recursive: true });
    vfs.mkdir('/home/user');
    vfs.writeFile('/home/user/hello.txt', 'Hello World');
    vfs.mkdir('/etc');
    vfs.writeFile('/etc/hostname', 'lifo\n');

    const serialized = serialize(vfs.getRoot());
    const restored = deserialize(serialized);

    // Build a new VFS from the restored root
    const vfs2 = new VFS();
    vfs2.loadFromSerialized(restored);

    expect(vfs2.readFileString('/home/user/hello.txt')).toBe('Hello World');
    expect(vfs2.readFileString('/etc/hostname')).toBe('lifo\n');
    expect(vfs2.stat('/home/user').type).toBe('directory');
  });

  it('round-trips binary data (Uint8Array)', () => {
    const vfs = new VFS();
    const binaryData = new Uint8Array([0, 1, 2, 128, 255, 0, 42]);
    vfs.writeFile('/binary', binaryData);

    const serialized = serialize(vfs.getRoot());
    const restored = deserialize(serialized);

    const vfs2 = new VFS();
    vfs2.loadFromSerialized(restored);

    const result = vfs2.readFile('/binary');
    expect(result).toEqual(binaryData);
  });

  it('excludes /proc and /dev children from serialization', () => {
    const vfs = new VFS();
    vfs.mkdir('/proc');
    vfs.mkdir('/dev');
    vfs.mkdir('/home');
    vfs.writeFile('/home/test', 'data');

    const serialized = serialize(vfs.getRoot());

    // Check that serialized children don't include proc/dev
    const childNames = serialized.c?.map((c) => c.n) ?? [];
    expect(childNames).not.toContain('proc');
    expect(childNames).not.toContain('dev');
    expect(childNames).toContain('home');
  });

  it('handles empty files', () => {
    const vfs = new VFS();
    vfs.writeFile('/empty', '');

    const serialized = serialize(vfs.getRoot());
    const restored = deserialize(serialized);

    const vfs2 = new VFS();
    vfs2.loadFromSerialized(restored);

    expect(vfs2.readFileString('/empty')).toBe('');
    expect(vfs2.stat('/empty').type).toBe('file');
  });

  it('preserves timestamps', () => {
    const vfs = new VFS();
    vfs.writeFile('/file', 'content');
    const origStat = vfs.stat('/file');

    const serialized = serialize(vfs.getRoot());
    const restored = deserialize(serialized);

    const vfs2 = new VFS();
    vfs2.loadFromSerialized(restored);

    const restoredStat = vfs2.stat('/file');
    expect(restoredStat.ctime).toBe(origStat.ctime);
    expect(restoredStat.mtime).toBe(origStat.mtime);
  });

  it('preserves file modes', () => {
    const vfs = new VFS();
    vfs.writeFile('/file', 'content');
    vfs.mkdir('/dir');

    const serialized = serialize(vfs.getRoot());
    const restored = deserialize(serialized);

    const vfs2 = new VFS();
    vfs2.loadFromSerialized(restored);

    expect(vfs2.stat('/file').mode).toBe(0o644);
    expect(vfs2.stat('/dir').mode).toBe(0o755);
  });

  it('excludes node_modules from persistence at any depth', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/project/node_modules/left-pad', { recursive: true });
    vfs.writeFile('/home/user/project/node_modules/left-pad/index.js', 'module.exports=1');
    vfs.writeFile('/home/user/project/package.json', '{"name":"app"}');
    vfs.mkdir('/node_modules', { recursive: true });
    vfs.writeFile('/node_modules/root-dep.js', 'x');

    const vfs2 = new VFS();
    vfs2.loadFromSerialized(deserialize(serialize(vfs.getRoot())));

    // User files survive…
    expect(vfs2.readFileString('/home/user/project/package.json')).toBe('{"name":"app"}');
    // …but node_modules (nested and root) is dropped.
    expect(vfs2.exists('/home/user/project/node_modules')).toBe(false);
    expect(vfs2.exists('/node_modules')).toBe(false);
  });

  it('round-trips a larger binary file (chunked base64)', () => {
    const vfs = new VFS();
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    vfs.writeFile('/blob.bin', big);

    const vfs2 = new VFS();
    vfs2.loadFromSerialized(deserialize(serialize(vfs.getRoot())));
    expect(vfs2.readFile('/blob.bin')).toEqual(big);
  });
});
