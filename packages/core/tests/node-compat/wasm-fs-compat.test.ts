// What Emscripten's NODEFS (PGlite, other wasm ports) and stream pipelines need from the shims.
import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createFs } from '../../src/node-compat/fs.js';
import { Readable, Writable } from '../../src/node-compat/stream.js';
import * as zlib from '../../src/node-compat/zlib.js';

describe('fs stats and times', () => {
  const setup = () => {
    const vfs = new VFS();
    vfs.mkdir('/data', { recursive: true });
    vfs.writeFile('/data/f', 'x');
    return createFs(vfs, '/');
  };

  it('mode carries the file type bits, like Node', () => {
    const fs = setup();
    expect(fs.lstatSync('/data')!.mode & 0o170000).toBe(0o040000);
    expect(fs.statSync('/data/f')!.mode & 0o170000).toBe(0o100000);
    expect(fs.statSync('/data/f')!.mode & 0o777).toBe(0o644);
    const fd = fs.openSync('/data/f', 'r');
    expect(fs.fstatSync(fd).mode & 0o170000).toBe(0o100000);
  });

  it('utimes, futimes, fchmod and fchown exist and check their target', () => {
    const fs = setup();
    expect(() => fs.utimesSync('/data/f', new Date(), new Date())).not.toThrow();
    expect(() => fs.utimesSync('/data/missing', 1, 1)).toThrow(/ENOENT/);
    const fd = fs.openSync('/data/f', 'r');
    expect(() => fs.futimesSync(fd, 1, 1)).not.toThrow();
    expect(() => fs.fchmodSync(fd, 0o600)).not.toThrow();
    expect(() => fs.fchownSync(fd, 1000, 1000)).not.toThrow();
  });
});

describe('fs.rmSync', () => {
  it('removes files and, with recursive, directories; force ignores missing paths', () => {
    const vfs = new VFS();
    vfs.mkdir('/d/sub', { recursive: true });
    vfs.writeFile('/d/sub/f', 'x');
    vfs.writeFile('/g', 'y');
    const fs = createFs(vfs, '/');
    fs.rmSync('/g');
    expect(vfs.exists('/g')).toBe(false);
    expect(() => fs.rmSync('/d')).toThrow();
    fs.rmSync('/d', { recursive: true, force: true });
    expect(vfs.exists('/d')).toBe(false);
    expect(() => fs.rmSync('/nope')).toThrow(/ENOENT/);
    expect(() => fs.rmSync('/nope', { force: true })).not.toThrow();
  });
});

describe('streaming zlib', () => {
  it('createGunzip decompresses through pipe(), like fs.createReadStream(f).pipe(gunzip)', async () => {
    const text = 'hello '.repeat(5000);
    const gz = await new Promise<Uint8Array>((res, rej) => zlib.gzip(text, (e: Error | null, r?: Uint8Array) => (e ? rej(e) : res(r!))));
    const chunks: Uint8Array[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk as Uint8Array); cb(); } });
    const done = new Promise((r) => sink.on('finish', r));
    const g = zlib.createGunzip();
    (g as unknown as { pipe(d: unknown): void }).pipe(sink);
    g.write(gz.subarray(0, 100));
    g.end(gz.subarray(100));
    await done;
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(text);
  });

  it('createGzip output round-trips through gunzip', async () => {
    const out: Uint8Array[] = [];
    const g = zlib.createGzip();
    g.on('data', (c) => { out.push(c as Uint8Array); });
    const ended = new Promise((r) => g.on('end', r));
    g.end('round trip');
    await ended;
    const back = await new Promise<Uint8Array>((res, rej) => zlib.gunzip(Buffer.concat(out), (e: Error | null, r?: Uint8Array) => (e ? rej(e) : res(r!))));
    expect(new TextDecoder().decode(back)).toBe('round trip');
  });
});

describe('Writable options', () => {
  it('new Writable({ write, final }) uses them', async () => {
    const seen: string[] = [];
    const w = new Writable({
      write(chunk, _enc, cb) { seen.push(String(chunk)); cb(); },
      final(cb) { seen.push('final'); cb(); },
    });
    const finished = new Promise((r) => w.on('finish', r));
    w.write('a');
    w.end('b');
    await finished;
    expect(seen).toEqual(['a', 'b', 'final']);
  });

  it('a subclass _write still wins', () => {
    const seen: unknown[] = [];
    class Sink extends Writable { override _write(c: unknown, _e: string, cb: () => void) { seen.push(c); cb(); } }
    new Sink().write('x');
    expect(seen).toEqual(['x']);
    expect(Readable).toBeDefined();
  });
});
