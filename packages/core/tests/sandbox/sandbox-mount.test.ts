import { describe, it, expect, afterEach } from 'vitest';
import { Sandbox } from '../../src/sandbox/index.js';
import type { NativeFsModule } from '../../src/kernel/vfs/providers/NativeFsProvider.js';
import { encode } from '../../src/utils/encoding.js';

// ─── In-memory mock of NativeFsModule ───

interface MockFile {
  type: 'file';
  data: Uint8Array;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface MockDir {
  type: 'dir';
  children: Map<string, MockFile | MockDir>;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

type MockEntry = MockFile | MockDir;

function createMockFs(): { fs: NativeFsModule; tree: MockDir } {
  const tree: MockDir = {
    type: 'dir',
    children: new Map(),
    mode: 0o755,
    mtimeMs: 1000,
    ctimeMs: 1000,
  };

  function resolvePath(p: string): { parent: MockDir; name: string } | null {
    const parts = p.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const name = parts.pop()!;
    let current: MockEntry = tree;
    for (const part of parts) {
      if (current.type !== 'dir') return null;
      const child = current.children.get(part);
      if (!child) return null;
      current = child;
    }
    if (current.type !== 'dir') return null;
    return { parent: current, name };
  }

  function resolveEntry(p: string): MockEntry | null {
    const parts = p.split('/').filter(Boolean);
    if (parts.length === 0) return tree;
    let current: MockEntry = tree;
    for (const part of parts) {
      if (current.type !== 'dir') return null;
      const child = current.children.get(part);
      if (!child) return null;
      current = child;
    }
    return current;
  }

  const fs: NativeFsModule = {
    readFileSync(path: string): Uint8Array {
      const entry = resolveEntry(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (entry.type !== 'file') throw Object.assign(new Error(`EISDIR: ${path}`), { code: 'EISDIR' });
      return entry.data;
    },

    writeFileSync(path: string, data: string | Uint8Array): void {
      const r = resolvePath(path);
      if (!r) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      const bytes = typeof data === 'string' ? encode(data) : data;
      const existing = r.parent.children.get(r.name);
      if (existing && existing.type === 'dir') {
        throw Object.assign(new Error(`EISDIR: ${path}`), { code: 'EISDIR' });
      }
      r.parent.children.set(r.name, {
        type: 'file',
        data: new Uint8Array(bytes),
        mode: 0o644,
        mtimeMs: Date.now(),
        ctimeMs: existing ? (existing as MockFile).ctimeMs : Date.now(),
      });
    },

    existsSync(path: string): boolean {
      return resolveEntry(path) !== null;
    },

    statSync(path: string) {
      const entry = resolveEntry(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        isFile: () => entry.type === 'file',
        isDirectory: () => entry.type === 'dir',
        size: entry.type === 'file' ? entry.data.length : (entry as MockDir).children.size,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        mode: entry.mode,
      };
    },

    readdirSync(path: string, _options: { withFileTypes: true }) {
      const entry = resolveEntry(path);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (entry.type !== 'dir') throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' });
      return Array.from(entry.children.entries()).map(([name, child]) => ({
        name,
        isFile: () => child.type === 'file',
        isDirectory: () => child.type === 'dir',
      }));
    },

    unlinkSync(path: string): void {
      const r = resolvePath(path);
      if (!r) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      const entry = r.parent.children.get(r.name);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (entry.type === 'dir') throw Object.assign(new Error(`EISDIR: ${path}`), { code: 'EISDIR' });
      r.parent.children.delete(r.name);
    },

    mkdirSync(path: string, options?: { recursive?: boolean }): void {
      if (options?.recursive) {
        const parts = path.split('/').filter(Boolean);
        let current: MockEntry = tree;
        for (const part of parts) {
          if (current.type !== 'dir') throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' });
          let child = current.children.get(part);
          if (!child) {
            child = { type: 'dir', children: new Map(), mode: 0o755, mtimeMs: Date.now(), ctimeMs: Date.now() };
            current.children.set(part, child);
          }
          current = child;
        }
        return;
      }
      const r = resolvePath(path);
      if (!r) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (r.parent.children.has(r.name)) {
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      }
      r.parent.children.set(r.name, {
        type: 'dir', children: new Map(), mode: 0o755, mtimeMs: Date.now(), ctimeMs: Date.now(),
      });
    },

    rmdirSync(path: string): void {
      const r = resolvePath(path);
      if (!r) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      const entry = r.parent.children.get(r.name);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      if (entry.type !== 'dir') throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' });
      if ((entry as MockDir).children.size > 0) {
        throw Object.assign(new Error(`ENOTEMPTY: ${path}`), { code: 'ENOTEMPTY' });
      }
      r.parent.children.delete(r.name);
    },

    renameSync(oldPath: string, newPath: string): void {
      const rOld = resolvePath(oldPath);
      if (!rOld) throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: 'ENOENT' });
      const entry = rOld.parent.children.get(rOld.name);
      if (!entry) throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: 'ENOENT' });
      const rNew = resolvePath(newPath);
      if (!rNew) throw Object.assign(new Error(`ENOENT: ${newPath}`), { code: 'ENOENT' });
      rOld.parent.children.delete(rOld.name);
      rNew.parent.children.set(rNew.name, entry);
    },

    copyFileSync(src: string, dest: string): void {
      const srcEntry = resolveEntry(src);
      if (!srcEntry) throw Object.assign(new Error(`ENOENT: ${src}`), { code: 'ENOENT' });
      if (srcEntry.type !== 'file') throw Object.assign(new Error(`EISDIR: ${src}`), { code: 'EISDIR' });
      const rDest = resolvePath(dest);
      if (!rDest) throw Object.assign(new Error(`ENOENT: ${dest}`), { code: 'ENOENT' });
      rDest.parent.children.set(rDest.name, {
        type: 'file',
        data: new Uint8Array(srcEntry.data),
        mode: srcEntry.mode,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
      });
    },
  };

  return { fs, tree };
}

// ─── Tests ───

describe('Sandbox.mountNative', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('mounts a native filesystem directory and reads files', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/readme.txt', 'hello from host');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/project', '/hostdir', { fsModule: mockFs });

    const content = await sandbox.fs.readFile('/mnt/project/readme.txt');
    expect(content).toBe('hello from host');
  });

  it('mounts a native filesystem directory and writes files', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/project', '/hostdir', { fsModule: mockFs });

    await sandbox.fs.writeFile('/mnt/project/new.txt', 'written via sandbox');
    const content = await sandbox.fs.readFile('/mnt/project/new.txt');
    expect(content).toBe('written via sandbox');
  });

  it('mounts read-only and blocks writes', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/data.txt', 'protected');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/ro', '/hostdir', { readOnly: true, fsModule: mockFs });

    // Reading works
    const content = await sandbox.fs.readFile('/mnt/ro/data.txt');
    expect(content).toBe('protected');

    // Writing should throw
    await expect(sandbox.fs.writeFile('/mnt/ro/data.txt', 'overwrite')).rejects.toThrow();
  });

  it('lists directory contents from mounted filesystem', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/a.txt', 'aaa');
    mockFs.writeFileSync('/hostdir/b.txt', 'bbb');
    mockFs.mkdirSync('/hostdir/subdir');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/data', '/hostdir', { fsModule: mockFs });

    const entries = await sandbox.fs.readdir('/mnt/data');
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'subdir']);
  });

  it('unmountNative removes the mount', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/file.txt', 'content');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/temp', '/hostdir', { fsModule: mockFs });

    // Verify mount works
    const content = await sandbox.fs.readFile('/mnt/temp/file.txt');
    expect(content).toBe('content');

    // Unmount
    sandbox.unmountNative('/mnt/temp');

    // Should now fail - the VFS readFile throws synchronously since the mount is gone,
    // and SandboxFsImpl.readFile uses Promise.resolve(syncCall()) which propagates
    // synchronous exceptions rather than creating rejected promises.
    let threw = false;
    try {
      await sandbox.fs.readFile('/mnt/temp/file.txt');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('mounts specified via SandboxOptions are wired up during create', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/project', { recursive: true });
    mockFs.writeFileSync('/project/index.ts', 'console.log("hello")');

    sandbox = await Sandbox.create({
      mounts: [
        { virtualPath: '/mnt/code', hostPath: '/project', fsModule: mockFs },
      ],
    });

    const content = await sandbox.fs.readFile('/mnt/code/index.ts');
    expect(content).toBe('console.log("hello")');
  });

  it('multiple mounts via SandboxOptions all work', async () => {
    const { fs: mockFs1 } = createMockFs();
    mockFs1.mkdirSync('/dir1', { recursive: true });
    mockFs1.writeFileSync('/dir1/a.txt', 'from dir1');

    const { fs: mockFs2 } = createMockFs();
    mockFs2.mkdirSync('/dir2', { recursive: true });
    mockFs2.writeFileSync('/dir2/b.txt', 'from dir2');

    sandbox = await Sandbox.create({
      mounts: [
        { virtualPath: '/mnt/one', hostPath: '/dir1', fsModule: mockFs1 },
        { virtualPath: '/mnt/two', hostPath: '/dir2', fsModule: mockFs2 },
      ],
    });

    expect(await sandbox.fs.readFile('/mnt/one/a.txt')).toBe('from dir1');
    expect(await sandbox.fs.readFile('/mnt/two/b.txt')).toBe('from dir2');
  });

  it('readOnly mount via SandboxOptions blocks writes', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/rodir', { recursive: true });
    mockFs.writeFileSync('/rodir/config.json', '{}');

    sandbox = await Sandbox.create({
      mounts: [
        { virtualPath: '/mnt/config', hostPath: '/rodir', readOnly: true, fsModule: mockFs },
      ],
    });

    const content = await sandbox.fs.readFile('/mnt/config/config.json');
    expect(content).toBe('{}');

    await expect(sandbox.fs.writeFile('/mnt/config/config.json', '{"new": true}')).rejects.toThrow();
  });

  it('throws on mountNative after destroy', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/dir', { recursive: true });

    sandbox = await Sandbox.create();
    sandbox.destroy();

    expect(() => {
      sandbox.mountNative('/mnt/x', '/dir', { fsModule: mockFs });
    }).toThrow('Sandbox is destroyed');
  });

  it('throws on unmountNative after destroy', async () => {
    sandbox = await Sandbox.create();
    sandbox.destroy();

    expect(() => {
      sandbox.unmountNative('/mnt/x');
    }).toThrow('Sandbox is destroyed');
  });

  it('throws on mountNative without fsModule in non-Node environment', async () => {
    sandbox = await Sandbox.create();

    // In the test environment, globalThis.require may not exist or may not
    // have node:fs. The method should throw a descriptive error.
    // We can't guarantee this will always throw (it might work in Node.js test env),
    // so we test with a scenario where we explicitly don't pass fsModule
    // and mock the globalThis.require to not exist.
    const origRequire = globalThis.require;
    const proc = process as unknown as Record<string, unknown>;
    const origGetBuiltin = proc.getBuiltinModule;
    try {
      // Temporarily remove both ways core finds node:fs: require, and (in ES modules)
      // process.getBuiltinModule.
      (globalThis as Record<string, unknown>).require = undefined;
      proc.getBuiltinModule = undefined;

      expect(() => {
        sandbox.mountNative('/mnt/x', '/some/host/path');
      }).toThrow('mountNative requires a Node.js environment');
    } finally {
      // Restore
      (globalThis as Record<string, unknown>).require = origRequire;
      proc.getBuiltinModule = origGetBuiltin;
    }
  });

  it('fs shim operations delegate through mount for mounted paths', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/test.txt', 'mounted content');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/host', '/hostdir', { fsModule: mockFs });

    // Use commands.run to test that shell commands also work with mounted paths
    const result = await sandbox.commands.run('cat /mnt/host/test.txt');
    expect(result.stdout).toBe('mounted content');
    expect(result.exitCode).toBe(0);
  });

  it('stat on mounted file returns correct info', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/data.bin', 'abcdef');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/files', '/hostdir', { fsModule: mockFs });

    const stat = await sandbox.fs.stat('/mnt/files/data.bin');
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(6);
  });

  it('exists returns true for mounted files, false for missing', async () => {
    const { fs: mockFs } = createMockFs();
    mockFs.mkdirSync('/hostdir', { recursive: true });
    mockFs.writeFileSync('/hostdir/real.txt', 'yes');

    sandbox = await Sandbox.create();
    sandbox.mountNative('/mnt/check', '/hostdir', { fsModule: mockFs });

    expect(await sandbox.fs.exists('/mnt/check/real.txt')).toBe(true);
    expect(await sandbox.fs.exists('/mnt/check/missing.txt')).toBe(false);
  });
});
