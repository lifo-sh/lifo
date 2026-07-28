# Lifo roadmap

## North star

**A developer can run agent code, dev servers, and real stacks in a sandbox that boots instantly — in the browser and in Node today, and as a single Docker-free binary you can drop on any host tomorrow.**

The measure of success isn't a feature checklist; it's: take a real project, point your tools at Lifo, and it just runs — the same VM whether it's a browser tab or a server-side process.

## Scope: what Lifo is (and isn't)

Lifo is a **tiny Linux-like VM** — a kernel with a virtual filesystem, a bash-like shell, 60+ coreutils, a Node.js compatibility layer, and a package manager — that runs **in a browser tab** or **in Node**.

**In scope**

- A believable POSIX-ish environment: FS, shell, processes, ports, a virtual network.
- Enough Node.js compatibility that real CLIs and dev servers run unmodified.
- Running real stacks (create-expo-app, Vite, Expo Router, Supabase via tinbase).
- Sandboxing agent-generated code safely, client-side or server-side.

**Out of scope**

- Being a full Linux kernel / running arbitrary native ELF binaries.
- A hosted cloud product. Lifo is a library and (soon) a binary you run yourself.

## Current state

Runs in the browser and in Node today — the same VM, client-side or server-side. Already shipped:

- [x] Kernel: virtual filesystem (IndexedDB-persisted in the browser), bash-like shell, process registry, virtual network + ports.
- [x] 60+ coreutils (ls, grep, sed, awk, find, tar, curl, …) and Git in every shell.
- [x] Node.js compatibility layer (http, fs, net, child_process, streams, crypto, readline, …).
- [x] Real npm & npx from the registry.
- [x] Real stacks unmodified: create-expo-app (SDK 54 & 57), Vite + React, Expo Router, Supabase (tinbase).
- [x] Live previews — in-VM ports served over a service worker with HMR.
- [x] Snapshot & restore a box's disk state.
- [x] Per-box process manager (list, kill, stop, restart).
- [x] Same-origin CORS proxy so the VM reaches api.expo.dev with no relay.

## Phases (ordered by real impact)

Each item ships independently and keeps the test suite green.

**Current focus (in order):**

1. A **Node.js + Express example with the preview browser** — a full backend + live preview in one box (part of phase 7).
2. **Lighter Vite bundling** — prune and/or hosted pre-bundle via `esm.reactnative.run` (part of phase 12).

### 1. Benchmarks for browser & Node — *in progress*

Reproducible numbers behind the claims, so "~0 ms boot, $0 infra" is backed by data.

- [x] **Unified harness across all environments** (`bench/suite/`, one shared workload): in-process Node, a single self-contained binary (bun `--compile`), and headless-Chromium browser. Measured — boot **~0.5 ms** (Node & browser), single-binary cold start **~41 ms** (spawn→box→command→exit), ~200–350K command ops/s, core **0.3 MB** gzipped. `node bench/suite/run-all.mjs` → [`bench/RESULTS.md`](bench/RESULTS.md).
- [x] **Head-to-head vs WebContainers** (`bench/suite/compare-webcontainers.mjs`): Lifo boots a browser box in ~27 ms / 0.3 MB vs WebContainers ~6.6 s / ~75-85 MB wasm-Node engine (they trade it for fuller Node fidelity; both ship node + npm by default). Plus cloud-microVM (Vercel Sandbox / e2b) positioning — [`bench/COMPARISON.md`](bench/COMPARISON.md).
- [ ] Dev-server cold-start (Vite) measured end to end.
- [ ] Keep the harness in CI so regressions show up; surface the stats on the website.

### 2. The `lifo` CLI — *planned*

A `lifo` command-line tool to run a box straight from your terminal — the on-ramp to server-side use before the standalone binary lands. Bonus: it gives Windows a consistent POSIX shell + coreutils build environment (npm scripts like `rm -rf dist && NODE_ENV=production …` just work, same paths and semantics as macOS/Linux) without WSL or Docker — for pure-JS toolchains. Native compilation stays out of scope, so it complements WSL/Docker rather than replacing them; the host-fs mount (phase 3) is what makes it useful for building a local project.

- [ ] `lifo` — boot a box and drop into its interactive shell.
- [ ] `lifo run <script.js>` — run a script in a fresh box and exit with its code.
- [ ] `--mount <hostDir>:<vmPath>` — map a host directory into the VM (see phase 3).
- [ ] `--expose <port>` — forward an in-VM port to localhost.
- [ ] Config/flags for env, cwd, and which filesystem backend to use.
- [ ] Cross-platform build parity: verify common POSIX-assuming npm scripts run on Windows in a box.

### 3. Filesystem persistence & durability — *planned*

Today the VFS is in-memory with IndexedDB persistence in the browser and whole-disk snapshots. Make the backing store pluggable and durable per environment.

- [ ] Backend interface: one VFS, swappable persistence layers.
- [ ] Browser persistent layer — IndexedDB today; evaluate OPFS for larger/faster disks.
- [ ] Host filesystem backend — back a box's disk with a real directory when running via the CLI.
- [ ] Volatile in-memory backend — throwaway sandboxes with no persistence.
- [ ] Snapshot & restore (have it) → export/import a box image across environments.
- [ ] Write-ahead log (WAL) for crash-consistent, incremental persistence (vs. snapshot-only).

### 4. A single distributable binary for host VMs — *exploring*

Lifo already runs in Node. Next: a single `lifo` binary (no Node install required) that runs **isolated VM instances per use case** — per-agent, per-project, per-request — so you can spin up and tear down disposable sandboxes on a server without Docker.

- [ ] Bundle the runtime into a self-contained executable.
- [ ] Isolation boundary + lifecycle API for many concurrent VMs in one host process.
- [ ] Resource limits (cpu/mem/fs quotas) per VM.

### 5. Tunnelling & network — *planned*

- [ ] Expose an in-VM port to a public URL through a tunnel (self-hosted relay or hosted proxy).
- [ ] Harden the WebSocket tunnel + relay (`apps/tunnel-server`): auth, reconnect, multiplexing.
- [ ] Cloud/host proxy for hosts without a same-origin service worker.
- [ ] Document using Lifo in place of Docker for local dev and CI sandboxes — honestly, for the cases where it fits.

### 6. Host escape hatches (opt-in) — *exploring*

A deliberate, permissioned way to step outside the sandbox and talk to the host. These are powerful and risky by design — off by default, gated behind explicit per-capability permissions, and never enabled implicitly.

- [ ] Host command execution (CLI/Node): run real host-machine commands from inside a box — e.g. `osascript`/AppleScript on macOS, or a whitelisted shell.
- [ ] Browser API bridge: call Web APIs (clipboard, notifications, geolocation, …) from in-VM code, through a mediated channel.
- [ ] A capability/permission model: opt-in per hatch, auditable, revocable; clear docs on the risks.
- [ ] Sensible defaults: everything disabled unless the embedder explicitly grants it.

### 7. Embeddable UI (terminal & browser) — *in progress*

Turn the playground's building blocks into reusable components so anyone can embed a Lifo UI. Shipped in `@lifo-sh/ui` (framework-agnostic).

- [x] Terminal component — a themeable terminal bound to a box's shell (core).
- [x] Preview browser component — an iframe view bound to an in-VM port (core), with back/forward/reload + a friendly address bar.
- [x] Package + document the components with a from-scratch integration example (see the Embeddable UI doc).
- [ ] Browser chrome — tabs, history (*low priority*, after the core views).
- [ ] Migrate the playground to consume the packaged components (dogfood).
- [x] Example: a **Node/Express server with the preview browser** bound to its port — a full backend + live preview in one box, alongside the existing Vite/Expo examples. **← current focus #1**
- [x] **Supabase (tinbase) fidelity:** both the Supabase (tinbase) and Expo Router + Supabase examples ship a real `supabase/` folder (`config.toml`, `migrations/*.sql`, `seed.sql`) and start the backend with the `npx tinbase --engine pgmem` CLI (like `supabase start`) — no hand-written `server.mjs`, no hard-coded migration. Each has a `README.txt`.
  - Fixed in 0.7.1: `npx tinbase --engine pgmem` died with `Cannot read properties of undefined (reading 'slice')`. The ESM→CJS masker's `scanBracedExpr` called `isRegexStart` with two arguments against a three-parameter signature, so **any `/` inside a `${…}` template expression threw** — which `pg-mem`, `tinbase/dist/db/pgmem-engine.js` and `schema-diff.js` all contain (`` `${l.replace(/'/g, "''")}` ``), and nothing else in the examples did. Note the thrown error names the *parent* module being executed, not the module whose transform failed; sweeping `transformEsmToCjs` over every file in `node_modules` is what located it. Covered by `tests/commands/esm-transform.test.ts`; verified end-to-end by `bench/test-tinbase-cli.mjs`.

### 8. Package manager & WASM runtimes — *planned*

- [ ] First-class package manager for VM tools.
- [ ] **Keep the core light.** We've been stuffing commands into `@lifo-sh/core`; move the non-essential ones out into installable packages, pulled in on demand. Core ships only the essentials; everything else is a package. *Underway* — extracted to their own `lifo-pkg-*` packages (removed from the core registry; the playground registers them via `shell.ts`; tests moved with the code): `fastfetch`/`neofetch`, `nano`, `less`, `vi`/`vim`, `cal`, `bc`, `man`. Per-command package mirroring `lifo-pkg-git`/`ffmpeg`/`sl`. The 60+ POSIX coreutils stay in core. Remaining ideas: `sl` (community PR #10), and wiring `lifo install` for on-demand fetch.
- [x] `vi`/`vim` editor — a usable modal subset on the nano/less full-screen infra: normal/insert/command modes; motions h/j/k/l/w/b/e/0/^/$/gg/G + arrows/Ctrl-D/U; i/a/I/A/o/O; x/X/s, dd/dw/D, cc/cw/C, r; yy/p/P; u + Ctrl-R; /search + n/N; count prefixes (3dd); :w [file]/:q/:q!/:wq/:x. Shipped as a **core** command for now (`vi`/`vim`); extract to an installable package with the keep-core-light work below.
- [ ] `ssh` client (as an installable package). Needs a WebSocket/tunnel transport for the connection — ties into phase 5 (tunnelling & network).
- [x] **Command redirects ("the Lifo way").** When a user runs a tool Lifo can't run natively that has an in-VM equivalent, print a one-line note and transparently run the equivalent: `supabase …` → `npx tinbase …`, `npx supabase …` → `npx tinbase …` (tinbase is Supabase-compatible). Tools with no equivalent (docker) get a note only, and `npm install supabase` notes tinbase (guarding the legit `@supabase/supabase-js` client). Curated map in `shell/command-suggestions.ts`; extensible.
- [ ] Pluggable WASM runtimes so more binaries (ffmpeg, Python, native CLIs) run inside the VM.

### 9. Broader Node & serverless coverage — *planned*

- [ ] Extend the Node compatibility layer toward serverless handlers.
- [ ] Cover more of the ecosystem unmodified.

### 10. Off-main-thread VM (Web Worker) — *planned*

Heavy VM work (npm install, bundling, snapshot dumps) runs synchronously on the browser main thread and freezes the tab. Move the whole VM into one dedicated module Worker per box so the UI never blocks. Design is complete and parked in [docs/plans/vm-in-web-worker.md](docs/plans/vm-in-web-worker.md) — ships dark behind `VITE_VM_WORKER`, no public API change (worker mode is additive/opt-in).

- [ ] Hand-rolled page↔worker RPC protocol + `ITerminal` proxy/adapter (same-thread first).
- [ ] `BoxHost` boot orchestration behind RPC; commands/inspector/snapshot into the worker.
- [ ] Move `ServiceWorkerBridge` into the worker via `MessagePort` transfer (page stays the SW registrar).
- [ ] Flip transport to a real module Worker; validate ffmpeg.wasm (COOP/COEP unknown).
- [ ] `createBrowserBox()` bootstrap helper hiding SW + worker setup behind one call.

### 11. Dockerfile & Compose provisioning — *exploring*

Boot a Lifo box from a `Dockerfile`, and orchestrate several boxes from a `docker-compose.yml`. This is **not** OCI/Docker compatibility (running arbitrary base images and native ELF binaries stays out of scope — see Scope above). Instead, treat these files as a familiar **declarative provisioning format** for boxes: interpret the subset of instructions Lifo can honor, and clearly reject the rest. The payoff is a zero-friction on-ramp — point Lifo at an existing repo's Dockerfile and it just boots.

- [ ] Dockerfile subset interpreter: `WORKDIR`, `COPY`/`ADD`, `ENV`, `ARG`, `EXPOSE` (→ port forward), `RUN` (for shell/npm steps the VM already supports), `CMD`/`ENTRYPOINT`. `FROM node:*`/`FROM alpine` maps to the base VM environment rather than a pulled image.
- [ ] Honest capability boundary: statically detect and clearly report instructions/base images Lifo can't run (native package installs, non-JS runtimes) instead of failing opaquely.
- [ ] `docker-compose.yml` → multiple boxes wired over the virtual network, with `ports`/`depends_on`/`environment` mapped to Lifo's ports + network + env.
- [ ] Surface it in the CLI (`lifo up`, `lifo build -f Dockerfile`) and as a browser provisioning input.
- [ ] Interop with WASM runtimes (phase 8): as more binaries run in-VM, more `RUN` steps become honorable.

### 12. Lighter browser bundling for mobile — *exploring*

Snapshots are ~90MB, too big for phones. Two prototypes exist: `pruneExpoModules` (trim `node_modules` to Metro's read set → keeps the real toolchain, ~8-13% of `node_modules`) and a `browser-metro` engine (offloads package bundling to a hosted pre-bundler, `esm.reactnative.run` → ~2MB, no toolchain on device; switchable with real Metro).

- [ ] Decide per-stack: **prune** (keep the real toolchain in a smaller snapshot) vs **hosted pre-bundle** (tiny download, no on-device toolchain). Finding so far: the heavy-snapshot problem is **Metro / React-Native-specific**; Vite is already light (see below).
- [x] **Vite investigated** (measured, `bench/measure-vite.mjs`) — **no prune or hosted pre-bundle needed.** A Vite + React app is ~21 MB `node_modules` → a **4.5 MB full gzipped snapshot** (smaller than a *pruned* Expo app, ~8 MB). esbuild runs as wasm-from-CDN, so no native binary is in the read path. A generic prune *would* shave it to ~1.7 MB (Vite reads only ~16% of files), but the ROI is low and read-trace prune is fragile (misses dynamic requires). And `esm.reactnative.run` doesn't fit Vite: Metro's win was offloading on-device *app bundling*, but Vite serves ESM on demand and pre-bundles only deps (esbuild-wasm) — the dev toolchain (vite + rollup + babel ≈ 10 MB) must run in the VM regardless and can't be moved to a CDN.
- [ ] Turn prune into a one-shot pre-snapshot command per stack; document snapshot sizes.
- [ ] Full-screen commands (`nano`/`less`) don't re-fit on live terminal resize — they read `LINES`/`COLUMNS` once at launch (the shell now sets them to the real size, but a mid-run resize needs a `SIGWINCH`-style hook on `CommandContext`).

### 13. Users, permissions & Linux fidelity — *exploring*

Today the box boots as `user` (`user@lifo`). A Linux-like VM should default to **`root`** (like a fresh container), so the prompt reads `root@lifo:~#` — with `#` for root and `$` for a normal user.

- [ ] Default the box to the `root` user; prompt shows `root@lifo:~#` (`#` root / `$` non-root). Update `whoami`/`id`/`$USER`/`$HOME` (`/root`), the motd, examples, docs, and snapshots accordingly.
- [ ] Linux-standard user management, backed by `/etc/passwd`, `/etc/group`, `/etc/shadow`: `useradd`/`adduser`, `userdel`, `usermod`, `groupadd`/`groupdel`, `passwd`, `id`, `groups`, `su`, `sudo`.
- [ ] A real current-user model in the shell/kernel so those commands (and `whoami`/`id`) reflect the active user; `su`/`sudo` switch it and adjust `HOME`/`USER`/`PWD`.
- [ ] Wire it to file ownership/permissions: `chown`/`chmod` already exist — enforce them against the current user (ties into phase 3 persistence). Keep it honest — it's a believable POSIX-ish model, not a security boundary.

---

Priorities shift with real usage. Have a use case? Open an issue.
