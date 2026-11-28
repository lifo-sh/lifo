// Node behaviors create-next-app and `next dev` rely on: process.chdir, running process.execPath
// (/usr/bin/node), writing to fds 1 and 2, built-in modules programs can patch, one process
// object per program, a replaced global setImmediate, and fs streams subclassed the pre-class
// way (graceful-fs).
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

async function run(files: Record<string, string>, cmd: string) {
	const box = await Sandbox.create({ persist: false });
	await box.fs.mkdir('/tmp/p/sub', { recursive: true });
	await box.fs.mkdir('/tmp/p/node_modules/cond', { recursive: true });
	await box.fs.mkdir('/tmp/p/node_modules/esm-only', { recursive: true });
	for (const [name, src] of Object.entries(files)) await box.fs.writeFile(`/tmp/p/${name}`, src);
	return box.commands.run(`cd /tmp/p && ${cmd}`);
}

describe('node process parity', () => {
	it('process.chdir moves the program, not the shell', async () => {
		const r = await run({
			'main.js': [
				`const fs = require('fs'), path = require('path');`,
				`process.chdir('sub');`,
				`console.log(process.cwd(), path.resolve('x'));`,
				`fs.writeFileSync('rel.txt', 'here');`,
				`require('child_process').exec('pwd', (e, out) => {`,
				`  console.log('child', out.trim());`,
				`  try { process.chdir('/nope'); } catch (err) { console.log(err.code, err.syscall); }`,
				`  try { process.chdir('/tmp/p/main.js'); } catch (err) { console.log(err.code); }`,
				`});`,
			].join('\n'),
		}, 'node main.js; cat sub/rel.txt; echo; pwd');
		expect(r.stdout).toBe('/tmp/p/sub /tmp/p/sub/x\nchild /tmp/p/sub\nENOENT chdir\nENOTDIR\nhere\n/tmp/p\n');
	});

	it('runs process.execPath and other commands named by their system path', async () => {
		const r = await run({
			'main.js': [
				`const { spawn } = require('child_process');`,
				`const c = spawn(process.execPath, ['-e', 'console.log(40 + 2)']);`,
				`c.stdout.on('data', (d) => process.stdout.write('child says ' + d));`,
			].join('\n'),
		}, 'node main.js; /bin/echo from-bin; /usr/bin/nope');
		expect(r.stdout).toBe('child says 42\nfrom-bin\n');
		expect(r.stderr).toContain('/usr/bin/nope: command not found');
	});

	it('writes to fds 1 and 2 go to stdout and stderr', async () => {
		const r = await run({
			'main.js': [
				`const fs = require('fs');`,
				`fs.writeFileSync(process.stdout.fd, 'one\\n');`,
				`fs.writeSync(1, Buffer.from('two\\n'));`,
				`fs.writeSync(2, 'err\\n');`,
				`fs.appendFileSync(1, 'three\\n');`,
			].join('\n'),
		}, 'node main.js');
		expect(r.stdout).toBe('one\ntwo\nthree\n');
		expect(r.stderr).toBe('err\n');
	});

	it('built-in modules can be patched, and every module of the program sees it', async () => {
		const r = await run({
			'main.js': [
				`const crypto = require('crypto');`,
				`const original = crypto.randomUUID;`,
				`crypto.randomUUID = function () { return 'patched-' + original.call(this).length; };`,
				`console.log(require('./other.js'));`,
			].join('\n'),
			'other.js': `module.exports = require('node:crypto').randomUUID();`,
		}, 'node main.js');
		expect(r.stdout).toBe('patched-36\n');
	});

	it('one process object for the whole program', async () => {
		const r = await run({
			'main.js': [
				`require('./listen.js');`,
				`process.emit('custom', 'hello');`,
				`const tick = process.nextTick;`,
				`process.nextTick = (fn, ...a) => { console.log('patched nextTick'); tick(fn, ...a); };`,
				`require('./tick.js');`,
			].join('\n'),
			'listen.js': `process.on('custom', (v) => console.log('other module heard', v));`,
			'tick.js': `process.nextTick(() => console.log('ticked'));`,
		}, 'node main.js');
		expect(r.stdout).toBe('other module heard hello\npatched nextTick\nticked\n');
	});

	it('a bare setImmediate follows a replaced globalThis.setImmediate, as in Node', async () => {
		const r = await run({
			'main.js': [
				`const original = globalThis.setImmediate;`,
				`globalThis.setImmediate = (fn, ...a) => { console.log('captured'); return original(fn, ...a); };`,
				`try {`,
				`  require('./uses.js');`,
				`} finally {`,
				`  setTimeout(() => { globalThis.setImmediate = original; }, 20);`,
				`}`,
			].join('\n'),
			'uses.js': `setImmediate(() => console.log('ran'));`,
		}, 'node main.js');
		expect(r.stdout).toBe('captured\nran\n');
	});

	it('module.createRequire resolves from the file it is given', async () => {
		const r = await run({
			'main.js': [
				`require('module');`, // the first module to load 'module' used to decide every createRequire
				`console.log(require('./sub/lib.mjs').viaOwnRequire);`,
				`const { createRequire } = require('module');`,
				`console.log(createRequire('/tmp/p/sub/x.js')('./helper.js'), createRequire(new URL('file:///tmp/p/sub/')).resolve('./helper.js'));`,
			].join('\n'),
			'sub/lib.mjs': [
				`import { createRequire } from 'module';`,
				`const require = createRequire(import.meta.url);`,
				`export const viaOwnRequire = require('./helper.js');`,
			].join('\n'),
			'sub/helper.js': `module.exports = 'helper from sub';`,
		}, 'node main.js');
		expect(r.stdout).toBe('helper from sub\nhelper from sub /tmp/p/sub/helper.js\n');
	});

	it('package exports pick the first matching condition in key order, as Node does', async () => {
		const pkg = JSON.stringify({
			name: 'cond', version: '1.0.0',
			exports: {
				'./isServer': { development: './dev.js', worker: './server.js', browser: './client.js', node: './server.js', import: './client.mjs', require: './client.js' },
				'./nested': { node: { import: './esm-only.mjs' }, default: './fallback.js' },
				'./browser-only': { browser: './client.js' },
			},
		});
		const r = await run({
			'node_modules/cond/package.json': pkg,
			'node_modules/cond/server.js': `module.exports = 'server';`,
			'node_modules/cond/client.js': `module.exports = 'client';`,
			'node_modules/cond/fallback.js': `module.exports = 'fallback';`,
			'main.js': `console.log(require('cond/isServer'), require('cond/nested'), require('cond/browser-only'));`,
		}, 'node main.js');
		expect(r.stdout).toBe('server fallback client\n');
	});

	it('require() of an ES module with a default export is marked __esModule, as in Node 22.12+', async () => {
		const r = await run({
			'node_modules/esm-only/package.json': JSON.stringify({ name: 'esm-only', type: 'module', exports: { '.': './index.js' } }),
			'node_modules/esm-only/index.js': `export default class Thing { hello() { return 'hi'; } }\nexport const named = 1;`,
			'main.js': [
				// esbuild's __toESM, as Tailwind's CJS build has it
				`var V = (e, r, t) => (t = e != null ? Object.create(Object.getPrototypeOf(e)) : {}, Object.assign(t, e), (r || !e || !e.__esModule ? Object.defineProperty(t, 'default', { value: e, enumerable: true }) : t, e.__esModule ? Object.defineProperty(t, 'default', { value: e.default, enumerable: true }) : t));`,
				`const ns = require('esm-only');`,
				`console.log(ns.__esModule, Object.keys(ns).includes('__esModule'), new (V(ns).default)().hello(), ns.named);`,
			].join('\n'),
		}, 'node main.js');
		expect(r.stdout).toBe('true false hi 1\n');
	});

	it('timers expose a writable _idleStart', async () => {
		const r = await run({
			'main.js': [
				`const a = setTimeout(() => console.log('a'), 5);`,
				`const b = setTimeout(() => console.log('b'), 5);`,
				`console.log(typeof a._idleStart, a._idleTimeout);`,
				`b._idleStart = a._idleStart;`,
			].join('\n'),
		}, 'node main.js');
		expect(r.stdout).toBe('number 5\na\nb\n');
	});

	it('fs.WriteStream and fs.ReadStream can be subclassed the pre-class way (graceful-fs)', async () => {
		const r = await run({
			'main.js': [
				`const fs = require('fs');`,
				`function MyWrite(path, options) {`,
				`  if (!(this instanceof MyWrite)) return new MyWrite(path, options);`,
				`  fs.WriteStream.apply(this, arguments);`,
				`}`,
				`MyWrite.prototype = Object.create(fs.WriteStream.prototype);`,
				`function MyRead(path, options) { fs.ReadStream.apply(this, arguments); }`,
				`MyRead.prototype = Object.create(fs.ReadStream.prototype);`,
				`console.log(fs.createWriteStream('/tmp/p/x.txt') instanceof fs.WriteStream, fs.WriteStream('/tmp/p/y.txt') instanceof fs.WriteStream);`,
				`const w = new MyWrite('/tmp/p/out.txt');`,
				`w.write('a');`,
				`w.end('b', () => {`,
				`  console.log(fs.readFileSync('/tmp/p/out.txt', 'utf8'), w instanceof fs.WriteStream, w.bytesWritten);`,
				`  let got = '';`,
				`  new MyRead('/tmp/p/out.txt', { encoding: 'utf8' }).on('data', (d) => { got += d; }).on('end', () => console.log('read', got));`,
				`});`,
			].join('\n'),
		}, 'node main.js');
		expect(r.stdout).toBe('true true\nab true 2\nread ab\n');
	});
});
