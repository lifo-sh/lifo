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

## Browser (planned)

A headless-Chrome harness that mirrors the Node metrics inside a page (boot,
commands, FS) plus a Vite dev-server cold-start measured end to end. Tracked in
the roadmap; wire it into CI so regressions surface on every PR.
