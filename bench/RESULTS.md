# Lifo benchmark results

_2026-07-14T04:24:43.869Z · Node v22.19.0_

Measured with `node bench/suite/run-all.mjs` — the same workload
([`bench/suite/workload.mjs`](suite/workload.mjs)) run in three environments.

| metric | in-process Node | single binary | browser (Chromium) |
|---|---|---|---|
| boot avg | **0.58 ms** | 40.7 ms † | **0.66 ms** |
| boot p50 / p95 | 0.43 / 2.96 ms | 40.7 / 44.5 ms | 0.30 / 6.40 ms |
| commands (`true`) | 202K ops/s | — | 357K ops/s |
| fs write (1 KiB) | 451K ops/s | — | 294K ops/s |
| fs read (1 KiB) | 594K ops/s | — | 833K ops/s |
| memory | 65.7 MB rss / 10.4 MB heap | — | 10.6 MB heap |

† **single binary** = a full cold start: OS spawns the standalone executable
(bun `--compile`), boots a fresh box, runs `true`, and exits — the true
"lifo as one command" latency. The in-process and browser boots measure just
`Sandbox.create` inside a warm runtime.

**Browser core load:** 26 ms to fetch+parse+eval the core bundle
(localhost, so ≈ parse+eval; over the network add the 305 KB gzipped transfer).

## Footprint

| artifact | size |
|---|---|
| core — gzipped bundle | 305 KB |
| core — npm package (.tgz) | 423 KB |
| single binary (bun --compile, self-contained) | 58.62 MB |

The binary is large because it embeds the whole runtime; Lifo's own code is the
~305 KB bundle. No Node install, npm, or infra needed to run it.
