import { describe, it, expect, beforeEach } from 'vitest';
import { createRimraf } from '../../src/node-compat/rimraf.js';
import { VFS } from '../../src/kernel/vfs/index.js';

describe('rimraf shim', () => {
  let vfs: VFS;
  let rimraf: ReturnType<typeof createRimraf>;

  beforeEach(() => {
    vfs = new VFS();
    vfs.mkdir('/tmp');
    rimraf = createRimraf(vfs, '/');
  });

  describe('sync', () => {
    it('removes a single file', () => {
      vfs.writeFile('/tmp/file.txt', 'hello');
      expect(vfs.exists('/tmp/file.txt')).toBe(true);
      rimraf.sync('/tmp/file.txt');
      expect(vfs.exists('/tmp/file.txt')).toBe(false);
    });

    it('removes a directory recursively', () => {
      vfs.mkdir('/tmp/dir');
      vfs.mkdir('/tmp/dir/sub');
      vfs.writeFile('/tmp/dir/a.txt', 'a');
      vfs.writeFile('/tmp/dir/sub/b.txt', 'b');
      rimraf.sync('/tmp/dir');
      expect(vfs.exists('/tmp/dir')).toBe(false);
    });

    it('is a no-op for non-existent paths', () => {
      expect(() => rimraf.sync('/tmp/nope')).not.toThrow();
    });

    it('rimrafSync is the same as sync', () => {
      expect(rimraf.rimrafSync).toBe(rimraf.sync);
    });
  });

  describe('callback API', () => {
    it('removes a file and calls back with null', () => {
      vfs.writeFile('/tmp/file.txt', 'hello');
      let err: Error | null = null;
      rimraf('/tmp/file.txt', (e) => { err = e; });
      expect(err).toBeNull();
      expect(vfs.exists('/tmp/file.txt')).toBe(false);
    });

    it('removes a directory and calls back with null', () => {
      vfs.mkdir('/tmp/dir');
      vfs.writeFile('/tmp/dir/a.txt', 'a');
      let err: Error | null = null;
      rimraf('/tmp/dir', (e) => { err = e; });
      expect(err).toBeNull();
      expect(vfs.exists('/tmp/dir')).toBe(false);
    });

    it('accepts options object as second arg', () => {
      vfs.writeFile('/tmp/file.txt', 'hello');
      let err: Error | null = null;
      rimraf('/tmp/file.txt', {}, (e) => { err = e; });
      expect(err).toBeNull();
      expect(vfs.exists('/tmp/file.txt')).toBe(false);
    });

    it('is a no-op for non-existent paths', () => {
      let err: Error | null = null;
      rimraf('/tmp/nope', (e) => { err = e; });
      expect(err).toBeNull();
    });
  });

  describe('promise API (rimraf.rimraf)', () => {
    it('removes a file', async () => {
      vfs.writeFile('/tmp/file.txt', 'hello');
      await rimraf.rimraf('/tmp/file.txt');
      expect(vfs.exists('/tmp/file.txt')).toBe(false);
    });

    it('removes a directory recursively', async () => {
      vfs.mkdir('/tmp/dir');
      vfs.mkdir('/tmp/dir/sub');
      vfs.writeFile('/tmp/dir/sub/c.txt', 'c');
      await rimraf.rimraf('/tmp/dir');
      expect(vfs.exists('/tmp/dir')).toBe(false);
    });

    it('resolves for non-existent paths', async () => {
      await expect(rimraf.rimraf('/tmp/nope')).resolves.toBeUndefined();
    });
  });

  describe('alternative method aliases', () => {
    it('native/nativeSync work', () => {
      vfs.writeFile('/tmp/f.txt', 'x');
      rimraf.nativeSync('/tmp/f.txt');
      expect(vfs.exists('/tmp/f.txt')).toBe(false);
    });

    it('manual/manualSync work', () => {
      vfs.writeFile('/tmp/f.txt', 'x');
      rimraf.manualSync('/tmp/f.txt');
      expect(vfs.exists('/tmp/f.txt')).toBe(false);
    });

    it('windows/windowsSync work', () => {
      vfs.writeFile('/tmp/f.txt', 'x');
      rimraf.windowsSync('/tmp/f.txt');
      expect(vfs.exists('/tmp/f.txt')).toBe(false);
    });

    it('moveRemove/moveRemoveSync work', () => {
      vfs.writeFile('/tmp/f.txt', 'x');
      rimraf.moveRemoveSync('/tmp/f.txt');
      expect(vfs.exists('/tmp/f.txt')).toBe(false);
    });

    it('native returns a promise', async () => {
      vfs.writeFile('/tmp/f.txt', 'x');
      await rimraf.native('/tmp/f.txt');
      expect(vfs.exists('/tmp/f.txt')).toBe(false);
    });
  });

  describe('default export', () => {
    it('rimraf.default is rimraf itself', () => {
      expect(rimraf.default).toBe(rimraf);
    });
  });
});
