// Bundle the probes for each host. Core comes from the linked checkout's dist.
import { build } from 'esbuild';
const core = new URL('../../packages/core/dist/index.js', import.meta.url).pathname;
const common = {
  bundle: true, logLevel: 'error', mainFields: ['module', 'main'], platform: 'neutral',
  alias: { '@lifo-sh/core': core, 'lifo-pkg-git': new URL('../../packages/lifo-pkg-git/dist/index.js', import.meta.url).pathname }, nodePaths: [new URL('../../packages/lifo-pkg-git/node_modules', import.meta.url).pathname, new URL('../../node_modules', import.meta.url).pathname], external: ['node:*', 'cloudflare:*', '@lifo-sh/ui', 'ws'],
};
// ESM for workerd and Deno.
await build({ ...common, entryPoints: ['src/lifo-run.js'], outfile: 'dist/lifo-run.mjs', format: 'esm' });
// A script for Vercel's edge-runtime, which evaluates plain scripts, not modules.
await build({ ...common, entryPoints: ['src/lifo-run.js'], outfile: 'dist/lifo-run.iife.js', format: 'iife', globalName: 'LifoEdge' });
await build({ ...common, entryPoints: ['src/cf-worker.js'], outfile: 'dist/cf-worker.mjs', format: 'esm' });
console.log('built');
// QuickJS for workerd: the Cloudflare build of the Emscripten loader, the .wasm imported as a module.
await build({ bundle: true, logLevel: 'error', format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], entryPoints: ['src/qjs-worker.js'], outfile: 'dist/qjs-worker.mjs', external: ['./quickjs.wasm'] });
console.log('built qjs');
await build({ bundle: true, logLevel: 'error', format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], alias: { '@lifo-sh/core': new URL('../../packages/core/dist/index.js', import.meta.url).pathname },
  external: ['node:*', 'cloudflare:*', '@lifo-sh/ui', 'ws', './quickjs.wasm'], conditions: ['workerd', 'worker', 'browser'], entryPoints: ['src/do-box.js'], outfile: 'dist/do-box.mjs' });
console.log('built do-box');
