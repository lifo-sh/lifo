// QuickJS (compiled to wasm, imported as a module at build time) inside a Worker with no eval and no
// runtime wasm compilation: can it run JS that the host itself refuses to evaluate?
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import wasmModule from './quickjs.wasm';

const BENCH = `
  function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
  let s = 0; for (let i = 0; i < 1000000; i++) s += i % 7;
  JSON.stringify({ fib: fib(24), s, json: JSON.parse('{"a":[1,2,3]}').a.length, re: /b+/.exec('abbbc')[0] });
`;

function native() {
  function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
  let s = 0; for (let i = 0; i < 1000000; i++) s += i % 7;
  return JSON.stringify({ fib: fib(24), s, json: JSON.parse('{"a":[1,2,3]}').a.length, re: /b+/.exec('abbbc')[0] });
}

let qjs = null;
export default {
  async fetch() {
    const t0 = performance.now();
    const fresh = !qjs;
    qjs ??= await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule }));
    const loadMs = performance.now() - t0;
    const vm = qjs.newContext();
    const t1 = performance.now();
    const res = vm.evalCode(BENCH);
    const qjsMs = performance.now() - t1;
    let out;
    if (res.error) { out = 'error: ' + JSON.stringify(vm.dump(res.error)); res.error.dispose(); } else { out = vm.dump(res.value); res.value.dispose(); }
    vm.dispose();
    const t2 = performance.now();
    const nat = native();
    const nativeMs = performance.now() - t2;
    return Response.json({ fresh, loadMs, qjsMs, nativeMs, out, nat, same: out === nat });
  },
};
