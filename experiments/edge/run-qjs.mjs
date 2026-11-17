// QuickJS vs the host's own JIT on the same code (Node or Deno), plus load time and memory.
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
const BENCH = `(() => { function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
let s = 0; for (let i = 0; i < 1000000; i++) s += i % 7;
return JSON.stringify({ fib: fib(24), s }); })()`;
const mem = () => Math.round((globalThis.Deno ? Deno.memoryUsage().rss : process.memoryUsage().rss) / 1048576);
const m0 = mem();
let t = performance.now();
const qjs = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
const loadMs = performance.now() - t;
const vm = qjs.newContext();
const runs = [];
for (let i = 0; i < 3; i++) { t = performance.now(); const r = vm.evalCode(BENCH); runs.push(Math.round(performance.now() - t)); vm.dump(r.value); r.value.dispose(); }
vm.dispose();
const nat = [];
for (let i = 0; i < 3; i++) { t = performance.now(); (0, eval)(BENCH); nat.push(Math.round((performance.now() - t) * 10) / 10); }
console.log(JSON.stringify({ host: globalThis.Deno ? 'deno' : 'node', loadMs: Math.round(loadMs), quickjsMs: runs, nativeMs: nat, rssAddedMB: mem() - m0 }));
