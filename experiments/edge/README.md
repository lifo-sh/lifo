# Lifo on edge runtimes (experiments)

Can `@lifo-sh/core` run in an edge worker? Findings and recommendation:
`cloud/docs/edge-runtimes.md` (closed-source cloud repo; summary: yes, everything but eval-based
`node`; QuickJS covers scripts; Durable Object SQLite keeps files on Cloudflare).

Not part of the pnpm workspace. Uses the linked `../../packages/core/dist` and
`../../packages/lifo-pkg-git/dist`.

```bash
npm install && mkdir -p node_modules/@lifo-sh && ln -sfn ../../../../packages/core node_modules/@lifo-sh/core
cp node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm src/quickjs.wasm
cp src/quickjs.wasm dist/quickjs.wasm 2>/dev/null; node build.mjs

node run-node.mjs > out-node.txt; node show.cjs out-node.txt         # Node baseline
deno run -A run-deno.mjs > out-deno.txt; node show.cjs out-deno.txt  # Deno (Supabase Edge Functions)
node run-vercel-edge.mjs > out-vercel.txt; node show.cjs out-vercel.txt  # Vercel Edge VM
node run-qjs.mjs; deno run -A run-qjs.mjs                            # QuickJS vs V8
node --disallow-code-generation-from-strings --test adapter/lifo-edge.test.mjs
```

workerd with Cloudflare's production flags (no eval): `dist/workerd.capnp` (workload),
`dist/qjs.capnp` (QuickJS), `dist/do.capnp` (a box as a Durable Object with files on SQLite and
`node` on QuickJS; `curl -G localhost:4463 --data-urlencode 'cmd=node main.js'`). Run with
`cd dist && ../../../../cloud/node_modules/.bin/workerd serve <file>.capnp`.

- `src/probe.js`: what a host allows (eval, runtime wasm, gzip streams, ...).
- `src/lifo-run.js`: the same workload on every host (shell, files, tar/gzip, node, curl, git, snapshots).
- `adapter/lifo-edge.js`: `createEdgeSandbox()`, `node` on QuickJS, gzip fallback (prototype of `@lifo-sh/edge`).
- `src/do-box.js`: a Lifo box as a Cloudflare Durable Object.
