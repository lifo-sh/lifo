# How Lifo compares

Where Lifo sits next to the other "run code without your own machine/server"
options. Numbers we measured ourselves are reproducible from `bench/`; see
methodology at the bottom. Competitor products trade different things, so this
is about **fit**, not a scoreboard.

## Browser: Lifo vs WebContainers (StackBlitz)

WebContainers is the closest peer — a VM that runs in a browser tab. Measured in
the same headless Chromium (`bench/suite/browser.mjs` for Lifo,
`bench/suite/compare-webcontainers.mjs` for WebContainers):

| | Lifo | WebContainers |
|---|---|---|
| cold start to a ready box | **~27 ms** (26 ms load + 0.7 ms boot) | **~8 s** (1.1 s import + 6.8 s boot) |
| first command | included above | ~0.5 s |
| download footprint | **~0.3 MB** (gzipped core) | **~3.7 MB** runtime |
| cross-origin isolation (COOP/COEP) | **not required** | **required** (SharedArrayBuffer) |
| also runs server-side (Node) | **yes — same VM** | no (browser only) |
| license | open source, self-host | proprietary, commercial license |
| Node fidelity | compat layer (heavy bits via wasm/pkgs) | **higher** — closer to real Node |

**Read honestly:** Lifo is ~250× faster to boot and ~12× smaller to download,
needs no special headers, and runs identically in Node. WebContainers gives you
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
