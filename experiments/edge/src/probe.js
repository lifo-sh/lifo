// What does this host allow? Each check returns true/false or an error message.
// The 8-byte module is the smallest valid wasm binary (magic + version, no sections).
const WASM_EMPTY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

async function check(fn) {
  try {
    const r = await fn();
    return r === undefined ? true : r;
  } catch (e) {
    return `no: ${String(e && e.message ? e.message : e).slice(0, 120)}`;
  }
}

export async function probe() {
  return {
    newFunction: await check(() => new Function('return 2')() === 2),
    indirectEval: await check(() => (0, eval)('1 + 1') === 2),
    wasmCompileAsync: await check(async () => (await WebAssembly.compile(WASM_EMPTY)) instanceof WebAssembly.Module),
    wasmModuleSync: await check(() => new WebAssembly.Module(WASM_EMPTY) instanceof WebAssembly.Module),
    wasmInstantiateBytes: await check(async () => !!(await WebAssembly.instantiate(WASM_EMPTY)).instance),
    importDataUrl: await check(async () => (await import('data:text/javascript,export default 7')).default === 7),
    setTimeout: await check(() => new Promise((r) => setTimeout(() => r(true), 5))),
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    worker: typeof Worker !== 'undefined',
    compressionStream: typeof CompressionStream !== 'undefined',
    cryptoRandom: await check(() => crypto.getRandomValues(new Uint8Array(4)).length === 4),
    fetch: typeof fetch === 'function',
    processGlobal: typeof process !== 'undefined',
  };
}
