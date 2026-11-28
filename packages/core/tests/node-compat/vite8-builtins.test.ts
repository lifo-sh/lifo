// Node built-ins that Vite 8 and napi-rs wasm addons use and Lifo was missing or got wrong.
import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createFs } from '../../src/node-compat/fs.js';
import { pathToFileURL, fileURLToPath } from '../../src/node-compat/url.js';
import { createTimers, createTimersPromises } from '../../src/node-compat/timers.js';
import { createActivityTracker } from '../../src/node-compat/activity.js';
import { isDeepStrictEqual } from '../../src/node-compat/util.js';
import { createProcess } from '../../src/node-compat/process.js';

describe('fs stats with { bigint: true }', () => {
	it('returns BigInt fields and nanosecond times, keeping the type methods', () => {
		const vfs = new VFS();
		vfs.mkdir('/d');
		vfs.writeFile('/d/f.txt', 'hello');
		const fs = createFs(vfs, '/');
		const st = fs.statSync('/d/f.txt', { bigint: true });
		expect(st.size).toBe(5n);
		expect(typeof st.mode).toBe('bigint');
		expect(st.mtimeNs).toBe(st.mtimeMs * 1000000n);
		expect(st.isFile()).toBe(true);
		const dir = fs.lstatSync('/d', { bigint: true });
		expect(dir.isDirectory()).toBe(true);
		const fd = fs.openSync('/d/f.txt', 'r');
		expect(fs.fstatSync(fd, { bigint: true }).size).toBe(5n);
		// Without the option nothing changes.
		expect(fs.statSync('/d/f.txt').size).toBe(5);
	});
});

describe('url.pathToFileURL', () => {
	it('resolves relative paths against the cwd, like Node', () => {
		expect(pathToFileURL('/a/b.js').href).toBe('file:///a/b.js');
		expect(pathToFileURL('src/x.js', '/home/user/app').href).toBe('file:///home/user/app/src/x.js');
		expect(pathToFileURL('/a/dir/').href).toBe('file:///a/dir/');
	});

	it('encodes what a path may hold and a URL may not', () => {
		// Rolldown's virtual modules start with NUL; Vite 8's config bundler converts them.
		const url = pathToFileURL('\0rolldown/runtime.js', '/home/user/app');
		expect(url.href).toBe('file:///home/user/app/%00rolldown/runtime.js');
		expect(pathToFileURL('/a/100% #1?.js').href).toBe('file:///a/100%25%20%231%3F.js');
		expect(fileURLToPath(pathToFileURL('/a/100% #1?.js'))).toBe('/a/100% #1?.js');
	});
});

describe('timers/promises', () => {
	it('setTimeout resolves with the value and counts as pending work', async () => {
		const activity = createActivityTracker();
		const tp = createTimersPromises(createTimers(activity));
		const p = tp.setTimeout(5, 'done');
		expect(activity.pending()).toBe(1);
		await expect(p).resolves.toBe('done');
		expect(activity.pending()).toBe(0);
	});

	it('rejects with an AbortError when the signal aborts', async () => {
		const tp = createTimersPromises(createTimers(createActivityTracker()));
		const ac = new AbortController();
		const p = tp.setTimeout(10000, 'x', { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
	});

	it('setInterval is an async iterator', async () => {
		const tp = createTimersPromises(createTimers(createActivityTracker()));
		let n = 0;
		for await (const v of tp.setInterval(1, 'tick')) {
			expect(v).toBe('tick');
			if (++n === 3) break;
		}
		expect(n).toBe(3);
		await expect(tp.setImmediate(7)).resolves.toBe(7);
		await expect(tp.scheduler.wait(1)).resolves.toBeUndefined();
	});
});

describe('util.isDeepStrictEqual', () => {
	it('compares structurally with strict semantics', () => {
		expect(isDeepStrictEqual({ a: [1, { b: new Map([[1, 'x']]) }] }, { a: [1, { b: new Map([[1, 'x']]) }] })).toBe(true);
		expect(isDeepStrictEqual({ a: 1 }, { a: '1' })).toBe(false);
		expect(isDeepStrictEqual(NaN, NaN)).toBe(true);
		expect(isDeepStrictEqual([1, 2], [1, 2, 3])).toBe(false);
	});
});

describe('process.execArgv', () => {
	it('is an empty array (napi-rs loaders copy it onto their threads)', () => {
		const p = createProcess({ argv: [], env: {}, cwd: '/', stdout: { write() {} }, stderr: { write() {} } } as never);
		expect(p.execArgv).toEqual([]);
	});
});

describe("the module wrapper's timers", () => {
	it("stay the box's when a module imports a renamed setTimeout, and include setImmediate", async () => {
		const { default: node } = await import('../../src/commands/system/node.js');
		const vfs = new VFS();
		vfs.mkdir('/tmp');
		// Vite 8's dist/node/chunks/node.js: a renamed import, then a bare setTimeout(...).unref().
		vfs.writeFile('/tmp/m.mjs', [
			`import { setTimeout as setTimeout$1 } from 'node:timers/promises';`,
			`console.log(setTimeout === globalThis.setTimeout, typeof setTimeout(() => {}, 0).unref, typeof setTimeout$1);`,
			`console.log(typeof setImmediate, setImmediate === globalThis.setImmediate);`,
		].join('\n'));
		const out = { text: '', write(t: string) { this.text += t; } };
		const err = { text: '', write(t: string) { this.text += t; } };
		const code = await node({ args: ['/tmp/m.mjs'], env: {}, cwd: '/tmp', vfs, stdout: out, stderr: err, signal: new AbortController().signal });
		expect(err.text).toBe('');
		expect(code).toBe(0);
		expect(out.text).toBe('false function function\nfunction false\n');
	});
});

describe('Buffer', () => {
	it('from(ArrayBuffer, offset, length) is a view, and write(str, "utf16le") fills it (es-module-lexer)', async () => {
		const { Buffer: B } = await import('../../src/node-compat/buffer.js');
		const memory = new ArrayBuffer(16);
		const view = B.from(memory, 4, 8);
		expect(view.buffer).toBe(memory);
		expect([view.byteOffset, view.length]).toEqual([4, 8]);
		expect(view.write('ab', 'utf16le')).toBe(4);
		expect(Array.from(new Uint16Array(memory, 4, 2))).toEqual([97, 98]);
		const shared = new SharedArrayBuffer(8);
		B.from(shared).write('hi');
		expect(new Uint8Array(shared)[1]).toBe(105);
	});

	it("write() takes Node's argument forms and doesn't split characters", async () => {
		const { Buffer: B } = await import('../../src/node-compat/buffer.js');
		const b = B.alloc(6);
		expect(b.write('ff00', 'hex')).toBe(2);
		expect(b.write('zz', 2, 'latin1')).toBe(2);
		expect(b.write('é', 4, 1, 'utf8')).toBe(0); // two bytes don't fit in one
		expect(Array.from(b)).toEqual([0xff, 0, 122, 122, 0, 0]);
		expect(b.write('aGk=', 4, 2, 'base64')).toBe(2);
		expect(b.toString('latin1', 4)).toBe('hi');
		expect(() => b.write('x', 'nope')).toThrow(/Unknown encoding/);
	});

	it('encodes and decodes utf16le, latin1, ascii and base64url', async () => {
		const { Buffer: B } = await import('../../src/node-compat/buffer.js');
		expect(Array.from(B.from('hé', 'utf16le'))).toEqual([104, 0, 233, 0]);
		expect(B.from([104, 0, 233, 0]).toString('ucs2')).toBe('hé');
		expect(B.from('hé', 'latin1').toString('binary')).toBe('hé');
		expect(B.from([0xe9]).toString('ascii')).toBe('i');
		expect(B.from('a?b>', 'utf8').toString('base64url')).toBe('YT9iPg');
		expect(B.from('YT9iPg', 'base64url').toString()).toBe('a?b>');
		expect(B.byteLength('hé', 'utf16le')).toBe(4);
	});
});
