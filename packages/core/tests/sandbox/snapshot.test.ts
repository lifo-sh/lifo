import { describe, it, expect, afterEach } from 'vitest';
import { Sandbox } from '../../src/sandbox/index.js';
import { readSnapshotMetadata, SNAPSHOT_MANIFEST_ENTRY } from '../../src/kernel/vfs/snapshot.js';

describe('Snapshot import/export', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('round-trip: export then import restores files with correct content', async () => {
    sandbox = await Sandbox.create();

    // Create some files
    await sandbox.fs.writeFile('/home/user/hello.txt', 'Hello, world!');
    await sandbox.fs.mkdir('/home/user/subdir', { recursive: true });
    await sandbox.fs.writeFile('/home/user/subdir/nested.txt', 'nested content');

    // Export snapshot
    const snapshot = await sandbox.fs.exportSnapshot();
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot.length).toBeGreaterThan(0);

    // Destroy and create a fresh sandbox
    sandbox.destroy();
    sandbox = await Sandbox.create();

    // The custom files should not exist in the fresh sandbox's default layout
    // (The sandbox has default files from boot, but our custom nested.txt should not be there)

    // Import the snapshot
    await sandbox.fs.importSnapshot(snapshot);

    // Verify files exist with correct content
    const hello = await sandbox.fs.readFile('/home/user/hello.txt');
    expect(hello).toBe('Hello, world!');

    const nested = await sandbox.fs.readFile('/home/user/subdir/nested.txt');
    expect(nested).toBe('nested content');
  });

  it('excludes /proc and /dev from export', async () => {
    sandbox = await Sandbox.create();

    const snapshot = await sandbox.fs.exportSnapshot();

    // Import into a fresh sandbox and verify /proc and /dev are not in the snapshot
    // We can verify by parsing the tar -- but simpler: export, destroy, create fresh
    // (without boot providers), import, and check that /proc and /dev don't exist as real dirs

    // We'll use a more direct approach: export and check the snapshot doesn't
    // contain proc/dev entries by importing into a fresh sandbox
    sandbox.destroy();
    sandbox = await Sandbox.create();

    // Before import, /proc exists because the kernel registers it
    const procExistsBefore = await sandbox.fs.exists('/proc');
    expect(procExistsBefore).toBe(true); // virtual provider

    // The exported snapshot should not contain /proc or /dev entries
    // We can verify by checking that the decompressed tar does not have these paths
    const { decompressGzip, parseTar } = await import('../../src/utils/archive.js');
    const tar = await decompressGzip(snapshot);
    const entries = parseTar(tar);

    const procEntries = entries.filter(
      (e) => e.path === 'proc' || e.path.startsWith('proc/'),
    );
    const devEntries = entries.filter(
      (e) => e.path === 'dev' || e.path.startsWith('dev/'),
    );

    expect(procEntries).toHaveLength(0);
    expect(devEntries).toHaveLength(0);
  });

  it('directories are properly recreated on import', async () => {
    sandbox = await Sandbox.create();

    // Create a deep directory structure
    await sandbox.fs.mkdir('/home/user/a/b/c', { recursive: true });
    await sandbox.fs.writeFile('/home/user/a/b/c/deep.txt', 'deep file');
    await sandbox.fs.mkdir('/tmp/testdir', { recursive: true });
    await sandbox.fs.writeFile('/tmp/testdir/file.txt', 'tmp file');

    const snapshot = await sandbox.fs.exportSnapshot();

    // Fresh sandbox
    sandbox.destroy();
    sandbox = await Sandbox.create();

    await sandbox.fs.importSnapshot(snapshot);

    // Verify directories exist
    const aStat = await sandbox.fs.stat('/home/user/a');
    expect(aStat.type).toBe('directory');

    const bStat = await sandbox.fs.stat('/home/user/a/b');
    expect(bStat.type).toBe('directory');

    const cStat = await sandbox.fs.stat('/home/user/a/b/c');
    expect(cStat.type).toBe('directory');

    const deepContent = await sandbox.fs.readFile('/home/user/a/b/c/deep.txt');
    expect(deepContent).toBe('deep file');

    const tmpContent = await sandbox.fs.readFile('/tmp/testdir/file.txt');
    expect(tmpContent).toBe('tmp file');
  });

  it('handles binary content (Uint8Array)', async () => {
    sandbox = await Sandbox.create();

    // Write binary data (not valid UTF-8)
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x90]);
    await sandbox.fs.writeFile('/home/user/binary.bin', binaryData);

    const snapshot = await sandbox.fs.exportSnapshot();

    // Fresh sandbox
    sandbox.destroy();
    sandbox = await Sandbox.create();

    await sandbox.fs.importSnapshot(snapshot);

    // Read back as binary
    const restored = await sandbox.fs.readFile('/home/user/binary.bin', null);
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(restored.length).toBe(binaryData.length);
    for (let i = 0; i < binaryData.length; i++) {
      expect(restored[i]).toBe(binaryData[i]);
    }
  });

  it('Sandbox convenience methods delegate to fs', async () => {
    sandbox = await Sandbox.create();

    await sandbox.fs.writeFile('/home/user/test.txt', 'via sandbox');

    // Use Sandbox-level convenience methods
    const snapshot = await sandbox.exportSnapshot();
    expect(snapshot).toBeInstanceOf(Uint8Array);

    sandbox.destroy();
    sandbox = await Sandbox.create();

    await sandbox.importSnapshot(snapshot);

    const content = await sandbox.fs.readFile('/home/user/test.txt');
    expect(content).toBe('via sandbox');
  });
});

describe('snapshot portability (one format everywhere)', () => {
  // The point of the manifest: a snapshot carries session state, so the SAME file
  // restores in the browser, in Node and through the CLI. Before it existed the
  // CLI needed cwd/env and so invented a second, incompatible container.
  it('carries cwd and env in the archive, and restores them', async () => {
    const a = await Sandbox.create({ persist: false, env: { MY_VAR: 'set-in-box-a' } });
    await a.fs.mkdir('/home/user/project', { recursive: true });
    await a.fs.writeFile('/home/user/project/app.js', 'console.log(1)');
    a.cwd = '/home/user/project';

    const bytes = await a.exportSnapshot();

    const b = await Sandbox.create({ persist: false });
    expect(b.cwd).not.toBe('/home/user/project');

    const manifest = await b.importSnapshot(bytes);
    expect(manifest?.version).toBe(1);
    expect(manifest?.cwd).toBe('/home/user/project');
    expect(manifest?.env?.MY_VAR).toBe('set-in-box-a');

    // Applied, not merely reported.
    expect(b.cwd).toBe('/home/user/project');
    expect(b.env.MY_VAR).toBe('set-in-box-a');
    expect(await b.fs.readFile('/home/user/project/app.js')).toBe('console.log(1)');

    a.destroy(); b.destroy();
  });

  it('readSnapshotMetadata reads the manifest without a VFS', async () => {
    // The CLI needs mountPath BEFORE it has anywhere to restore into.
    const a = await Sandbox.create({ persist: false });
    const bytes = await a.exportSnapshot({ metadata: { mountPath: '/host/dir' } });
    const manifest = await readSnapshotMetadata(bytes);
    expect(manifest?.mountPath).toBe('/host/dir');
    expect(manifest?.savedAt).toBeTruthy();
    a.destroy();
  });

  it('the manifest is not restored as a file in the VFS', async () => {
    const a = await Sandbox.create({ persist: false });
    const bytes = await a.exportSnapshot();
    const b = await Sandbox.create({ persist: false });
    await b.importSnapshot(bytes);
    // It would land at /lifo-snapshot.json, since importVfsSnapshot prefixes
    // relative tar entries with '/'.
    expect(await b.fs.exists('/lifo-snapshot.json')).toBe(false);
    expect(await b.fs.exists('/' + SNAPSHOT_MANIFEST_ENTRY)).toBe(false);
    a.destroy(); b.destroy();
  });

  it('a files-only archive still restores (pre-manifest snapshots keep working)', async () => {
    const a = await Sandbox.create({ persist: false });
    await a.fs.writeFile('/home/user/only-files.txt', 'hello');
    const bytes = await a.exportSnapshot({ metadata: false });

    expect(await readSnapshotMetadata(bytes)).toBeNull();

    const b = await Sandbox.create({ persist: false });
    const cwdBefore = b.cwd;
    const manifest = await b.importSnapshot(bytes);
    expect(manifest).toBeNull();
    expect(b.cwd).toBe(cwdBefore);                       // nothing to apply
    expect(await b.fs.readFile('/home/user/only-files.txt')).toBe('hello');
    a.destroy(); b.destroy();
  });

  it('caller-supplied metadata merges with cwd/env rather than replacing them', async () => {
    const a = await Sandbox.create({ persist: false });
    const bytes = await a.exportSnapshot({ metadata: { mountPath: '/host/x', lifoVersion: 'test' } });
    const manifest = await readSnapshotMetadata(bytes);
    expect(manifest?.mountPath).toBe('/host/x');
    expect(manifest?.lifoVersion).toBe('test');
    expect(manifest?.cwd).toBeTruthy();     // still stamped automatically
    expect(manifest?.env).toBeTruthy();
    a.destroy();
  });
});
