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

### 1. Benchmarks for browser & Node — *in progress*

Reproducible numbers behind the claims, so "~0 ms boot, $0 infra" is backed by data.

- [ ] Node harness: boot time, command throughput, FS read/write, memory (`bench/`).
- [ ] Browser harness: same metrics in a headless Chrome page.
- [ ] Dev-server cold-start (Vite) measured end to end.
- [ ] Publish a report + keep the harness in CI so regressions show up.

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

### 8. Package manager & WASM runtimes — *planned*

- [ ] First-class package manager for VM tools.
- [ ] Pluggable WASM runtimes so more binaries (ffmpeg, Python, native CLIs) run inside the VM.

### 9. Broader Node & serverless coverage — *planned*

- [ ] Extend the Node compatibility layer toward serverless handlers.
- [ ] Cover more of the ecosystem unmodified.

## Known bugs

- [ ] **Expo in the Node environment (headless / CLI).** Running Expo in a box under Node (not the browser) has rough edges:
  - `npx create-expo-app` / `npx expo …` leak the *host* cwd into the VM, so a relative project path resolves against the host and `expo start/export` fail with `Invalid project root` / `ConfigError: expected package.json … does not exist`. Workarounds today: pass an **absolute** VM path to `create-expo-app`, and invoke the installed CLI directly (`node <app>/node_modules/@expo/cli/build/bin/cli …`) with the project root as a positional, not via `npx`. Fix the npx/cwd propagation so `npx expo` works unmodified.
  - `expo start` fatally errors on the Expo version endpoint (`CommandError: … Bad Gateway`) unless `EXPO_OFFLINE=1` is set; investigate the CORS-proxy path for `api.expo.dev` under Node.
  - `expo export --platform web` bundles fine but **crashes after bundling** with `TypeError: this.on is not a function` (an EventEmitter/stream shim gap in the export writer), so it never writes `dist/`. Blocks producing a real web export in-VM.
  - `expo start` logs `An unknown error occurred while installing React Native DevTools … node_modules/fb-dotslash/index.js: Cannot read properties of undefined (reading 'wasm')` — a `fb-dotslash`/WASM shim gap. Non-fatal (Metro continues) but noisy.
  - Repro harnesses: `bench/prune-trace.mjs`, `bench/gen-keepset.mjs`.

---

Priorities shift with real usage. Have a use case? Open an issue.
