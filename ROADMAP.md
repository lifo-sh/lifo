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

### 2. A single distributable binary for host VMs — *exploring*

Lifo already runs in Node. Next: a single `lifo` binary (no Node install required) that runs **isolated VM instances per use case** — per-agent, per-project, per-request — so you can spin up and tear down disposable sandboxes on a server without Docker.

- [ ] Bundle the runtime into a self-contained executable.
- [ ] Isolation boundary + lifecycle API for many concurrent VMs in one host process.
- [ ] Resource limits (cpu/mem/fs quotas) per VM.

### 3. Tunnelling & a Docker-free dev sandbox — *planned*

- [ ] Expose an in-VM port to a public URL through a tunnel.
- [ ] Document using Lifo in place of Docker for local dev and CI sandboxes — honestly, for the cases where it fits.

### 4. Package manager & WASM runtimes — *planned*

- [ ] First-class package manager for VM tools.
- [ ] Pluggable WASM runtimes so more binaries (ffmpeg, Python, native CLIs) run inside the VM.

### 5. Broader Node & serverless coverage — *planned*

- [ ] Extend the Node compatibility layer toward serverless handlers.
- [ ] Cover more of the ecosystem unmodified.

---

Priorities shift with real usage. Have a use case? Open an issue.
