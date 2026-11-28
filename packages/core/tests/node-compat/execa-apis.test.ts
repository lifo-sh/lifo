// Node APIs execa 9 relies on (the TanStack CLI runs git, npm and its route generator through
// it): child processes with real streams and Node's event order, events.on and friends,
// util.callbackify / promisify.custom / aborted, os signal numbers, stream defaults.
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

async function run(src: string) {
	const box = await Sandbox.create({ persist: false });
	await box.fs.writeFile('/tmp/main.mjs', src);
	return box.commands.run('node /tmp/main.mjs');
}

describe('APIs execa uses', () => {
	it('child processes have real streams, exit before close, and a closed stdin after exit', async () => {
		const r = await run([
			`import { spawn, ChildProcess } from 'node:child_process';`,
			`import { Readable, Writable } from 'node:stream';`,
			`const child = spawn('echo', ['hi']);`,
			`console.log(child instanceof ChildProcess, child.stdout instanceof Readable, child.stdin instanceof Writable);`,
			`child.stdout.setEncoding('utf8');`,
			`const order = [];`,
			`child.stdout.on('data', (d) => order.push('data:' + typeof d + ':' + d.trim()));`,
			`child.on('exit', (code) => order.push('exit ' + code + ' ' + child.exitCode));`,
			`child.stdin.on('close', () => order.push('stdin closed'));`,
			`child.on('close', (code) => { order.push('close ' + code); console.log(order.join(', ')); });`,
		].join('\n'));
		expect(r.stdout).toBe('true true true\nexit 0 0, stdin closed, data:string:hi, close 0\n');
	});

	it('a command that does not exist gets error, never spawn (execa waits on both)', async () => {
		const r = await run([
			`import { spawn } from 'node:child_process';`,
			`import { once } from 'node:events';`,
			`const child = spawn('no-such-command', ['x']);`,
			`const [spawned, exited] = await Promise.allSettled([once(child, 'spawn'), once(child, 'exit')]);`,
			`console.log(spawned.status, spawned.reason?.code, exited.status, child.stdin.destroyed);`,
			`const ok = spawn('echo', ['fine']);`,
			`await once(ok, 'spawn');`,
			`console.log('spawned', (await once(ok, 'exit'))[0]);`,
		].join('\n'));
		expect(r.stdout).toBe('rejected ENOENT rejected true\nspawned 0\n');
	});

	it('a child nobody reads still closes', async () => {
		const r = await run([
			`import { spawn } from 'node:child_process';`,
			`spawn('echo', ['unread']).on('close', (code) => console.log('closed', code));`,
		].join('\n'));
		expect(r.stdout).toBe('closed 0\n');
	});

	it('events.on iterates events until the signal aborts', async () => {
		const r = await run([
			`import { EventEmitter, on, setMaxListeners, getEventListeners, addAbortListener } from 'node:events';`,
			`const e = new EventEmitter();`,
			`const ac = new AbortController();`,
			`setMaxListeners(20, e, ac.signal);`,
			`console.log(e.getMaxListeners());`,
			`setTimeout(() => { e.emit('tick', 1); e.emit('tick', 2, 'x'); setTimeout(() => ac.abort(), 5); }, 5);`,
			`const got = [];`,
			`try {`,
			`  for await (const args of on(e, 'tick', { signal: ac.signal })) { got.push(args); if (got.length === 1) console.log('listeners', getEventListeners(e, 'tick').length); }`,
			`} catch (err) { console.log(err.name, JSON.stringify(got)); }`,
			`const ac2 = new AbortController();`,
			`const sub = addAbortListener(ac2.signal, () => console.log('aborted listener'));`,
			`ac2.abort();`,
			`sub[Symbol.dispose]();`,
		].join('\n'));
		expect(r.stdout).toBe('20\nlisteners 1\nAbortError [[1],[2,"x"]]\naborted listener\n');
	});

	it('util.callbackify, promisify.custom and aborted', async () => {
		const r = await run([
			`import util from 'node:util';`,
			`const cb = util.callbackify(async (x) => x * 2);`,
			`cb(21, (err, v) => console.log('callbackify', err, v));`,
			`util.callbackify(() => Promise.reject(null))((err) => console.log('falsy', err.code, err.reason));`,
			`function legacy(cb) { cb(null, 'plain'); }`,
			`legacy[util.promisify.custom] = () => Promise.resolve('custom');`,
			`console.log(await util.promisify(legacy)(), util.promisify.custom === Symbol.for('nodejs.util.promisify.custom'), typeof util.promisify(undefined));`,
			`const ac = new AbortController();`,
			`setTimeout(() => ac.abort(), 5);`,
			`await util.aborted(ac.signal, {});`,
			`console.log('aborted resolved');`,
		].join('\n'));
		expect(r.stdout).toBe('custom true function\ncallbackify null 42\nfalsy ERR_FALSY_VALUE_REJECTION null\naborted resolved\n');
	});

	it('os signal numbers and stream defaults', async () => {
		const r = await run([
			`import os from 'node:os';`,
			`import { getDefaultHighWaterMark, Readable, Writable } from 'node:stream';`,
			`console.log(os.constants.signals.SIGTERM, os.constants.signals.SIGKILL, os.constants.errno.ENOENT);`,
			`console.log(getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));`,
			`const r = new Readable({ objectMode: true }); const w = new Writable({ highWaterMark: 5 });`,
			`console.log(r.readableObjectMode, r.readableHighWaterMark, w.writableObjectMode, w.writableHighWaterMark, r.readableEncoding);`,
		].join('\n'));
		expect(r.stdout).toBe('15 9 2\n65536 16\ntrue 16 false 5 null\n');
	});
});
