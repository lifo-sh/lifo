import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { parseTar, parseTarStream, decompressGzip } from '../../src/utils/archive.js';

/** A stream that hands out `bytes` in chunks of `size` (odd sizes cross every block boundary). */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

async function sourceBox() {
  const box = await Sandbox.create();
  const deep = '/home/user/app/node_modules/@scope/' + 'a-very-long-directory-name/'.repeat(5) + 'index.js';
  await box.commands.run(`mkdir -p ${deep.slice(0, deep.lastIndexOf('/'))}`);
  await box.fs.writeFile(deep, 'module.exports = 42;\n');
  await box.fs.writeFile('/home/user/app/big.bin', new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251));
  await box.fs.writeFile('/home/user/app/hello.txt', 'hi\n');
  await box.commands.run('cd /home/user/app && ln -s hello.txt link.txt && chmod 755 hello.txt');
  await box.commands.run('mkdir -p /home/user/empty-dir');
  box.env.FOO = 'bar';
  return { box, deep };
}

describe('streaming snapshot import', () => {
  it('parseTarStream yields the same entries as parseTar, at any chunk size', async () => {
    const { box } = await sourceBox();
    const gz = await box.exportSnapshot();
    const tar = await decompressGzip(gz);
    const want = parseTar(tar).map((e) => ({ ...e, data: Array.from(e.data.slice(0, 64)), size: e.data.length }));
    for (const size of [7, 512, 65536, tar.length]) {
      const got = [];
      for await (const e of parseTarStream(chunked(tar, size))) got.push({ ...e, data: Array.from(e.data.slice(0, 64)), size: e.data.length });
      expect(got).toEqual(want);
    }
    box.destroy();
  });

  it('importSnapshot(stream) restores what importSnapshot(bytes) restores', async () => {
    const { box, deep } = await sourceBox();
    const gz = await box.exportSnapshot();
    const a = await Sandbox.create();
    const b = await Sandbox.create();
    const metaA = await a.importSnapshot(gz);
    const metaB = await b.importSnapshot(chunked(gz, 1000));
    expect(metaB).toEqual(metaA);
    expect(b.env.FOO).toBe('bar');
    for (const s of [a, b]) {
      expect(await s.fs.readFile(deep, 'utf8')).toBe('module.exports = 42;\n');
      expect(s.kernel.vfs.readFile('/home/user/app/big.bin').length).toBe(3 * 1024 * 1024);
      expect(s.kernel.vfs.readlink('/home/user/app/link.txt')).toBe('hello.txt');
      expect((await s.commands.run('ls -d /home/user/empty-dir')).exitCode).toBe(0);
    }
    const sa = a.kernel.vfs.stat('/home/user/app/hello.txt');
    const sb = b.kernel.vfs.stat('/home/user/app/hello.txt');
    expect(sb.mode).toBe(sa.mode);
    expect(sb.mtime).toBe(sa.mtime);
    const big = b.kernel.vfs.readFile('/home/user/app/big.bin');
    expect(big[1000]).toBe(1000 % 251);
    for (const s of [box, a, b]) s.destroy();
  });
});
