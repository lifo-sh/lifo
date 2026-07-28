import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listSnapshots, readSnapshotArchive } from '../src/snapshot.js';
import { readSnapshotMetadata, Sandbox } from '@lifo-sh/core';
import { startSession, type Session } from './helpers/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../dist/index.js');

/** Run the CLI the way a user would, without vitest's loader in the child. */
function cli(args: string[]): string {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

describe('listSnapshots', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Regression: this filtered `.zip` while `snapshot save` wrote `.tar.gz`, so
  // `lifo snapshot list` always said "No snapshots found".
  it('finds .tar.gz archives', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-snaplist-'));
    fs.writeFileSync(path.join(dir, 'a-123.tar.gz'), 'x');
    fs.writeFileSync(path.join(dir, 'b-456.tar.gz'), 'x');

    const found = listSnapshots(dir).map((p) => path.basename(p)).sort();
    expect(found).toEqual(['a-123.tar.gz', 'b-456.tar.gz']);
  });

  it('ignores unrelated files, including zips that can no longer be restored', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-snaplist-'));
    fs.writeFileSync(path.join(dir, 'real.tar.gz'), 'x');
    fs.writeFileSync(path.join(dir, 'legacy.zip'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');

    expect(listSnapshots(dir).map((p) => path.basename(p))).toEqual(['real.tar.gz']);
  });

  it('returns nothing when the directory does not exist', () => {
    expect(listSnapshots(path.join(os.tmpdir(), 'lifo-does-not-exist-' + Date.now()))).toEqual([]);
  });
});

describe('readSnapshotArchive', () => {
  it('rejects a file that is not an archive, with an actionable message', () => {
    const f = path.join(os.tmpdir(), `not-a-snapshot-${Date.now()}.zip`);
    fs.writeFileSync(f, 'PK pretend zip');
    try {
      expect(() => readSnapshotArchive(f)).toThrow(/Not a lifo snapshot archive/);
      expect(() => readSnapshotArchive(f)).toThrow(/no longer supported/);
    } finally {
      fs.unlinkSync(f);
    }
  });
});

describe('lifo snapshot save', () => {
  let session: Session | undefined;
  let outFile: string | undefined;

  afterEach(async () => {
    await session?.stop();
    session = undefined;
    if (outFile) { try { fs.unlinkSync(outFile); } catch { /* fine */ } }
    outFile = undefined;
  });

  it('writes an archive whose manifest carries the session cwd and env', async () => {
    session = await startSession();
    await session.run('mkdir -p /home/user/work');
    await session.run('echo saved-by-the-cli > /home/user/work/note.txt');
    await session.run('export SNAP_TEST=from-cli');
    await session.run('cd /home/user/work');

    outFile = path.join(os.tmpdir(), `cli-snap-${Date.now()}.tar.gz`);
    const out = cli(['snapshot', 'save', session.id, '--output', outFile]);
    expect(out).toContain('Snapshot saved to');
    expect(fs.existsSync(outFile)).toBe(true);

    const bytes = readSnapshotArchive(outFile);   // also asserts it's gzip
    const manifest = await readSnapshotMetadata(bytes);
    expect(manifest?.version).toBe(1);
    expect(manifest?.cwd).toBe('/home/user/work');
    expect(manifest?.env?.SNAP_TEST).toBe('from-cli');
    expect(typeof manifest?.mountPath).toBe('string');
  });

  // The reason the format was unified: a CLI snapshot has to open elsewhere.
  it('produces an archive a core box can restore, cwd and env included', async () => {
    session = await startSession();
    await session.run('mkdir -p /home/user/portable');
    await session.run('echo crosses-environments > /home/user/portable/proof.txt');
    await session.run('export PORTABLE=yes');
    await session.run('cd /home/user/portable');

    outFile = path.join(os.tmpdir(), `cli-snap-${Date.now()}.tar.gz`);
    cli(['snapshot', 'save', session.id, '--output', outFile]);

    const box = await Sandbox.create({ persist: false });
    try {
      await box.importSnapshot(readSnapshotArchive(outFile));
      expect((await box.fs.readFile('/home/user/portable/proof.txt')).trim()).toBe('crosses-environments');
      expect(box.cwd).toBe('/home/user/portable');
      expect(box.env.PORTABLE).toBe('yes');
      // The manifest is metadata, not a file to restore.
      expect(await box.fs.exists('/lifo-snapshot.json')).toBe(false);
    } finally {
      box.destroy();
    }
  });
});
