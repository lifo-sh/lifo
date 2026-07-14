# How Lifo compares

Where Lifo sits next to the other "run code without your own machine/server"
options. Numbers we measured ourselves are reproducible from `bench/`; see
methodology at the bottom. Competitor products trade different things, so this
is about **fit**, not a scoreboard.

> **Reads like Linux, isn't Linux.** Lifo is a clean-room reimplementation of the
> OS and Node.js APIs in TypeScript — not a Linux distribution or a VM. It
> behaves like a Unix box for a wide range of work (shells, npm/pnpm, dev
> servers, previews, agent code, CI), but it doesn't run native Linux binaries
> and its isolation is JS-level, not a security boundary. Several rows below span
> categories — treat them as fit-for-use, not like-for-like.

## Browser: Lifo vs WebContainers (StackBlitz)

WebContainers is the closest peer — a VM that runs in a browser tab. Measured in
the same headless Chromium (`bench/suite/browser.mjs` for Lifo,
`bench/suite/compare-webcontainers.mjs` for WebContainers):

Both give you `node` + `npm` by default, so we spawn both on each side rather
than comparing a bare boot.

| | Lifo (browser) | WebContainers (browser) |
|---|---|---|
| cold start to a ready box | **~27 ms** (26 ms load + 0.7 ms boot) | **~6.6 s** (1.0 s import + 5.6 s boot) |
| first command | included above | ~0.7 s |
| runtime footprint (node + npm) | **~0.3 MB** (gzipped core) | **~75-85 MB** (wasm Node engine) |
| cross-origin isolation (COOP/COEP) | **not required** | **required** (SharedArrayBuffer) |
| also runs server-side (Node) | **yes — same VM** | no (browser only) |
| license | open source, self-host | proprietary, commercial license |
| Node fidelity | compat layer (heavy bits via wasm/pkgs) | **higher** — closer to real Node |

**Read honestly:** Lifo is ~250× faster to boot and ~250× smaller, needs no
special headers, and runs identically in Node. WebContainers ships a real-er
Node — a wasm build of the actual Node engine — which is why its runtime is
~75-85 MB on boot. (That footprint can't be captured from the page: WebContainers
streams its engine into a **Web Worker**, invisible to Playwright's
`request.sizes()` and to a page-scoped CDP Network session — both bottom out
around 0.01 MB of resources here. The ~75-85 MB is StackBlitz's documented
runtime weight; our script reports the main-thread lower bound alongside it.) WebContainers gives you
**fuller Node fidelity** (a real-er Node in the browser). Pick Lifo when boot
time, size, header-freedom, and client+server parity matter; pick WebContainers
when you need maximum Node compatibility in the browser and can absorb the
weight.

## Server: Lifo vs cloud sandboxes (Vercel Sandbox, e2b, Firecracker microVMs)

These are a **different category** — server-side, hardware-isolated compute you
provision on someone's cloud:

| axis | Lifo | Cloud microVM sandbox |
|---|---|---|
| where it runs | a browser tab **or your own** Node process | a provisioned cloud VM |
| cold start | ms | ~hundreds of ms – seconds |
| cost / infra | **$0, none** | billed per use, provisioned |
| isolation | JS-level (not a security boundary) | **real** (microVM / hardware) |
| runtime | Node-compat subset | **full Linux**, native binaries |

Published cold-start figures for the microVM family (server-side, *excludes* your
network round-trip; these are vendors' / typical published numbers, **not**
measured in our harness):

| sandbox | runs where | cold start (published) | isolation | footprint |
|---|---|---|---|---|
| Lifo (Node) | your Node process | ~0.5 ms (measured) | JS-level | 0.3 MB |
| Lifo (browser) | browser tab | ~27 ms (measured) | JS-level | 0.3 MB |
| Lifo (binary) | any host, single file | ~41 ms (measured) | JS-level | 59 MB |
| Firecracker microVM | server host | ~125 ms (VM boot only) | microVM (real) | — |
| E2B | cloud (Firecracker) | ~150-300 ms | microVM (real) | — |
| Fly.io Machines | cloud (Firecracker) | ~0.3-3 s (from stopped) | microVM (real) | — |
| Vercel Sandbox | cloud microVM | ~hundreds ms – s | microVM (real) | — |

Think of it as a spectrum, not a competition:

> **client preview** (Lifo in the browser) → **cheap in-process server sandbox**
> (Lifo in Node) → **real isolated cloud microVM** (Vercel Sandbox / e2b /
> Firecracker)

Use Lifo when you want instant, free, embeddable sandboxing and a Node-compat
subset is enough (agent code, previews, teaching, CI). Reach for a cloud microVM
when you need a real isolation boundary, full Linux, or native binaries.

## Methodology

- Lifo numbers: `node bench/suite/run-all.mjs` (in-process Node, single binary,
  and headless-Chromium browser) — same workload in every environment
  (`bench/suite/workload.mjs`). Full results in [`RESULTS.md`](RESULTS.md).
- WebContainers: `node bench/suite/compare-webcontainers.mjs` — boots
  `@webcontainer/api` in the same headless Chromium, times import + boot + first
  command, and sums the bytes downloaded. "Cold" = first boot, cache cold.
- All on the same machine/Node version; numbers vary by hardware, so treat the
  **ratios** as the story, not the absolute ms.
