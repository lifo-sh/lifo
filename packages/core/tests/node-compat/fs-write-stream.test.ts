// fs.createWriteStream: Node's write/end/close callback forms, events, and large writes.
import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createFs } from '../../src/node-compat/fs.js';

function setup() {
	const vfs = new VFS();
	vfs.mkdir('/tmp');
	return { vfs, fs: createFs(vfs, '/') };
}
const done = (s: { once(e: string, f: () => void): unknown }, event = 'close') => new Promise<void>((r) => s.once(event, () => r()));

describe('fs.createWriteStream', () => {
	it('calls write(chunk, callback) back, as Next.js waits on it while it downloads', async () => {
		const { vfs, fs } = setup();
		const s = fs.createWriteStream('/tmp/a.bin');
		const order: string[] = [];
		await new Promise<void>((r) => s.write(new Uint8Array([1, 2]), () => { order.push('w1'); r(); }));
		await new Promise<void>((r) => s.write('ab', 'utf8', () => { order.push('w2'); r(); }));
		await new Promise<void>((r) => (s as unknown as { close(cb: () => void): void }).close(() => { order.push('closed'); r(); }));
		expect(order).toEqual(['w1', 'w2', 'closed']);
		expect([...vfs.readFile('/tmp/a.bin')]).toEqual([1, 2, 97, 98]);
	});

	it('writes small files through at once, and large ones by the end', async () => {
		const { vfs, fs } = setup();
		const small = fs.createWriteStream('/tmp/log.txt');
		small.write('line 1\n');
		expect(vfs.readFileString('/tmp/log.txt')).toBe('line 1\n');
		small.end('line 2\n');
		expect(vfs.readFileString('/tmp/log.txt')).toBe('line 1\nline 2\n');

		const big = fs.createWriteStream('/tmp/big.bin');
		const chunk = new Uint8Array(64 * 1024).fill(7);
		for (let i = 0; i < 64; i++) big.write(chunk); // 4 MB
		const finished = done(big, 'finish');
		big.end();
		await finished;
		expect(vfs.readFile('/tmp/big.bin').length).toBe(4 * 1024 * 1024);
		expect((big as unknown as { bytesWritten: number }).bytesWritten).toBe(4 * 1024 * 1024);
	});

	it('appends with flags "a", emits open, and reports a missing directory as an error', async () => {
		const { vfs, fs } = setup();
		vfs.writeFile('/tmp/x.txt', 'a');
		const s = fs.createWriteStream('/tmp/x.txt', { flags: 'a' });
		const opened = new Promise<number>((r) => s.once('open', (fd: unknown) => r(fd as number)));
		s.end('b', () => {});
		expect(typeof (await opened)).toBe('number');
		expect(vfs.readFileString('/tmp/x.txt')).toBe('ab');

		const bad = fs.createWriteStream('/nope/dir/file.txt');
		const err = await new Promise<{ code?: string }>((r) => bad.once('error', (e: unknown) => r(e as { code?: string })));
		expect(err.code).toBe('ENOENT');
	});
});

describe('fs.opendir', () => {
	it('lists entries by for await, read() and the callback form', async () => {
		const { vfs, fs } = setup();
		vfs.mkdir('/tmp/app');
		vfs.writeFile('/tmp/app/page.js', '');
		vfs.writeFile('/tmp/app/layout.js', '');
		vfs.mkdir('/tmp/app/blog');
		const files: string[] = [];
		for await (const entry of await fs.promises.opendir('/tmp/app')) if (entry.isFile()) files.push(entry.name);
		expect(files.sort()).toEqual(['layout.js', 'page.js']);

		const dir = fs.opendirSync('/tmp/app');
		const names: string[] = [];
		for (let e = await dir.read(); e; e = await dir.read()) names.push(e.name);
		expect(names.sort()).toEqual(['blog', 'layout.js', 'page.js']);
		await dir.close();
		expect(() => dir.readSync()).toThrow(/closed/);

		const err = await new Promise<{ code?: string }>((r) => fs.opendir('/tmp/missing', (e: unknown) => r(e as { code?: string })));
		expect(err.code).toBe('ENOENT');
	});
});
