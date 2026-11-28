# Lifo benchmarks

Reproducible numbers for the "browser & Node benchmarks" roadmap item — so
claims like "boots in ~0 ms, $0 infra" are backed by data, not vibes.

## Node

Measures a box booting, shell-command throughput, filesystem throughput, and
memory — running the same VM in Node.

```bash
pnpm --filter @lifo-sh/core build   # the harness imports the built dist
node bench/node-bench.mjs           # human-readable table
node bench/node-bench.mjs --json    # machine-readable
```

Example (M-series laptop, Node 22):

```
Boot (Sandbox.create, cold, ×20)   avg ~0.6 ms
Shell commands (`true` ×500)       ~240k ops/s
Filesystem (1 KiB ×500)            ~480k write / ~540k read ops/s
Memory                             ~60 MB rss
```

Numbers vary by machine; treat them as relative, and re-run on the same box to
catch regressions.

## Vite 8 (Rolldown as wasm)

`vite8-smoke.mjs` installs a Vite 8 + React + TypeScript app in a Node-hosted box, starts the
dev server, fetches a transformed `.tsx` module and the Rolldown-pre-bundled react-dom, then runs
`vite build`. It checks the napi-rs `wasm32-wasi` support end to end (Rolldown and Oxc run as
WebAssembly with real threads). Needs the npm registry; set `VITE8_SMOKE_CACHE=<file.tgz>` to
reuse the install between runs.

```bash
pnpm --filter @lifo-sh/core build
node bench/vite8-smoke.mjs
```

Example (M-series laptop, Node 24): dev server ready in ~430 ms, `vite build` ~160 ms,
470-620 MB host rss with the dev server up (more right after a fresh `npm install`).

## Browser (planned)

A headless-Chrome harness that mirrors the Node metrics inside a page (boot,
commands, FS) plus a Vite dev-server cold-start measured end to end. Tracked in
the roadmap; wire it into CI so regressions surface on every PR.
