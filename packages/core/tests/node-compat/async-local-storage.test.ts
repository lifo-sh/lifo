// AsyncLocalStorage carries its store across async work in a box program, as in Node:
// awaits, promise callbacks, timers, immediates and nextTick (React Server Components and
// Next.js keep each request's state this way).
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { instrumentAwaits } from '../../src/node-compat/await-context.js';

async function runNode(src: string) {
	const box = await Sandbox.create({ persist: false });
	await box.fs.writeFile('/tmp/als.js', src);
	return box.commands.run('node /tmp/als.js');
}

describe('AsyncLocalStorage across async work', () => {
	it('keeps the store across awaits, callbacks and timers, separately for concurrent runs', async () => {
		const r = await runNode(`
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const tick = () => new Promise((r) => setTimeout(r, 5));
const seen = [];
async function request(id) {
  await tick();
  seen.push(id + ':await=' + als.getStore());
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  seen.push(id + ':immediate=' + als.getStore());
  Promise.resolve().then(() => seen.push(id + ':then=' + als.getStore()));
  setTimeout(() => seen.push(id + ':timeout=' + als.getStore()), 1);
  process.nextTick(() => seen.push(id + ':tick=' + als.getStore()));
  queueMicrotask(() => seen.push(id + ':micro=' + als.getStore()));
  await tick();
  await tick();
  return als.getStore();
}
(async () => {
  const results = await Promise.all([als.run('A', () => request('a')), als.run('B', () => request('b'))]);
  console.log(results.join(','), als.getStore());
  console.log(seen.filter((s) => s.startsWith('a:')).map((s) => s.split('=')[1]).join(''));
  console.log(seen.filter((s) => s.startsWith('b:')).map((s) => s.split('=')[1]).join(''));
})();
`);
		expect(r.stdout).toBe('A,B undefined\nAAAAAA\nBBBBBB\n');
	});

	it('nests, exits, enters, binds and snapshots', async () => {
		const r = await runNode(`
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const a = new AsyncLocalStorage();
const b = new AsyncLocalStorage();
const out = [];
a.run(1, () => {
  b.run(2, async () => {
    await null;
    out.push('nested ' + a.getStore() + b.getStore());
    a.exit(() => out.push('exit ' + a.getStore() + b.getStore()));
  });
  const resource = new AsyncResource('job');
  const later = AsyncLocalStorage.bind(() => a.getStore());
  const snap = AsyncLocalStorage.snapshot();
  a.run(9, () => out.push('bound ' + later() + ' snapshot ' + snap(() => a.getStore()) + ' resource ' + resource.runInAsyncScope(() => a.getStore())));
});
const c = new AsyncLocalStorage();
setTimeout(() => {
  c.enterWith('entered');
  setTimeout(() => { out.push('enterWith ' + c.getStore()); console.log(out.join('|')); }, 1);
}, 1);
`);
		expect(r.stdout).toBe('bound 1 snapshot 1 resource 1|nested 12|exit undefined2|enterWith entered\n');
	});
});

describe('await rewrite', () => {
	it('keeps the store across awaits in async functions compiled at run time (Vite module runner)', async () => {
		const r = await runNode(`
const { AsyncLocalStorage } = require('async_hooks');
const AsyncFunction = (async function () {}).constructor; // taken before any store is set, as Vite does
const als = new AsyncLocalStorage();
const body = 'await new Promise((r) => setTimeout(r, 5)); await null; return als.getStore();';
const compiled = new AsyncFunction('als', body);
console.log(compiled instanceof AsyncFunction, compiled.constructor === AsyncFunction);
als.run('request-1', () => compiled(als)).then((v) => console.log('store after awaits:', v));
`);
		expect(r.stdout).toBe('true true\nstore after awaits: request-1\n');
	});

	it('wraps each await, nested ones too, on the same lines', () => {
		const out = instrumentAwaits('async function f() {\n  return (await g(await h())) + await 1;\n}');
		expect(out).toBe('async function f() {\n  return (__lifoAsync.r(__lifoAsync.s(), await g(__lifoAsync.r(__lifoAsync.s(), await h())))) + __lifoAsync.r(__lifoAsync.s(), await 1);\n}');
		expect(instrumentAwaits('const awaited = 1; // await nothing')).toBe('const awaited = 1; // await nothing');
		expect(instrumentAwaits('this is not javascript await')).toBe('this is not javascript await');
		// webpack eval-source-map modules: the awaits inside the eval'd string are rewritten too.
		const evald = instrumentAwaits('eval(' + JSON.stringify('(async () => { await x; })()\n//# sourceURL=webpack-internal:///./a.js') + ');');
		expect(evald).toBe('eval(' + JSON.stringify('(async () => { __lifoAsync.r(__lifoAsync.s(), await x); })()\n//# sourceURL=webpack-internal:///./a.js') + ');');
	});
});
