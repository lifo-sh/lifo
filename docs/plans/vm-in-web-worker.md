# Plan: Move the Lifo VM into a Web Worker (kill UI freezes)

> **Status: parked / planned.** The design below is complete and ready to execute — no
> further exploration needed. Estimated ~5 PRs, ~500k–900k tokens end to end (Chrome test
> loops and the ffmpeg unknown dominate the variance). Ships entirely dark behind a flag;
> PRs 1–3 are same-thread refactors, real risk is concentrated in PR 4.

## Context
Heavy VM work on the browser main thread freezes the whole tab: a VFS snapshot dump, an `npm install`, or esbuild/babel bundling blocks paint, input, and even other boxes because the Kernel/Shell/VFS/node-compat all run synchronously in the page realm. The non-blocking snapshot (yields to the event loop) is a band-aid; the real fix is to run the VM off the main thread. This plan moves the entire VM into **one dedicated module Worker per box**, leaving only DOM-bound work (xterm, React, preview iframes, service-worker registration) on the page. Gated behind a flag so it ships dark and every step keeps the playground working.

Design findings baked in (from two Explore + two Plan passes):
- **No `SharedArrayBuffer` / no COOP+COEP.** stdin is Promise-based end-to-end (`TerminalStdin.read()`/`feed()`), and once the VFS lives in the worker every synchronous read is same-thread. The only sync cross-boundary read today is `terminal.cols/rows` during line editing (`Shell.ts:494/668/688`) — solved by caching geometry in the worker. Enabling COEP would break cross-origin assets loaded by preview apps, so we deliberately do not.
- **The `ITerminal` interface is already the seam** (`packages/core/src/terminal/ITerminal.ts`). Both boot patterns already accept a pre-built `ITerminal`, so no core boot API changes.
- **`MessagePort` entanglement survives transfer and is realm-agnostic** — this is what lets the service worker and the VM worker talk directly, page out of the data path.

## API impact (important)
- **No change to existing public API.** `Sandbox.create({terminal})`, `bootShell`, `commands.run`, `fs`, `exportSnapshot`, and `ITerminal` keep their signatures. Worker mode is *additive* and opt-in; main-thread and headless-Node usage are unaffected.
- **Package the setup behind one helper.** Add a high-level `createBrowserBox({container})` bootstrap that hides both the SW registration and the worker spawn, so integrators call one function instead of wiring SW + worker by hand. Raw `Sandbox.create` stays available for main-thread control.
- **One genuine regression:** `commands.register(name, closure)` with a page-supplied JS function can't cross `postMessage` in worker mode. Custom commands must live in the worker bundle or be passed as a module specifier the worker imports. The playground only injects built-ins (git/ffmpeg), which move into the worker, so it is unaffected.

## Architecture

**In the worker** (`apps/playground/src/worker/vm.worker.ts`, `{type:'module'}`):
Kernel + `boot()`, VFS + PersistenceManager (IndexedDB works in workers), Shell/interpreter/line-editing/stdin, the command registry and **all command modules imported here** (default registry + `lifo-pkg-git` + `lifo-pkg-ffmpeg` + node/curl/network), NetworkStack/`portRegistry`, `ServiceWorkerBridge` + `WebSocketTunnel`, process-inspector logic, snapshot export/import.

**On the page**: xterm `Terminal` (`@lifo-sh/ui`, DOM), React, preview iframes (`preview-browser.tsx`, unchanged), `navigator.serviceWorker.register` + the controller/`controllerchange`/`lifo-need-host` handshake (workers can't register/observe SWs), snapshot file dialog + `<a>` download.

### RPC protocol — hand-rolled, `packages/core/src/worker/protocol.ts` (types + `Rpc` helper, no DOM/Worker refs so it type-checks in both realms)
One channel per box. Envelope:
- `{k:'req', id, method, args}` / `{k:'res', id, ok, value|error}` — correlated RPC via a `Map<id,{resolve,reject}>`. Used for boot (`createSandbox`/`bootTab`), `commandsRun` initiation, `listProcesses`/`killProcess`, `exportSnapshot`/`importSnapshot`, `attachSwPort`.
- `{k:'ev', ch, msg}` — ordered fire-and-forget streams:
  - `term.write {termId,data}` (worker→page, **rAF-coalesced**), `term.clear {termId}` (worker→page)
  - `term.data {termId,data}` (page→worker keystrokes), `term.resize {termId,cols,rows}` (page→worker)
  - `run.stdout`/`run.stderr` `{runId,text}` (worker→page); the RPC `res` carries final `{stdout,stderr,exitCode}`
- **Transferables**: SW response ArrayBuffer and snapshot `Uint8Array` ride the `postMessage` transfer list (`value.buffer`), preserving today's zero-copy. A `post(frame, transfer?)` helper threads it.

Terminal I/O is keyed by `termId`, command runs by `runId`, so one shared channel multiplexes cleanly. `SandboxCommands`' promise queue stays in the worker (concurrency semantics unchanged).

### ITerminal split
- **`WorkerTerminalProxy implements ITerminal`** (`packages/core/src/worker/WorkerTerminalProxy.ts`): `write/writeln/clear` → `ev`; `cols/rows` → cached, updated by `term.resize` (seed 80×24, page pushes an initial resize right after boot); `onData(cb)` → invoked by the channel's `term.data` listener; `focus()` no-op. Raw-mode ordering holds because keystrokes are ordered `ev` on one channel and `setRawMode` is a worker-side flag flip.
- **`MainTerminalAdapter`** (`apps/playground/src/worker/main-terminal-adapter.ts`): subscribes `term.write`→**buffer, flush once per `requestAnimationFrame`** (single `xterm.write`); `xterm.onData`→`term.data`; xterm resize→`term.resize`. Coalescing is the key perf detail — never write per-event.
- A worker-side `BoxHost` exposes `createSandbox({files,cwd,env,termId})` (builds a proxy, calls the **existing** `Sandbox.create({terminal: proxy, ...})`) and `bootTab({termId,opts})` (builds a proxy, calls existing `bootShell(proxy, kernel, opts)`). One kernel, many `termId`s → `Map<termId,{proxy,shell}>`. Supports `interactive.tsx` multi-tab and `project-example.tsx` extra terminals with no core change.

### Service-worker routing — Option A (bridge in worker, transfer the port)
Keeps the 12MB (PGlite/wasm) response a **single** zero-copy hop worker→SW; the page never sees preview/HMR traffic. Split `ServiceWorkerBridge`:
- **Page-side `SwRegistrar`**: `register()`/`ready`, `controllerchange` + `lifo-need-host` listeners, reconnect trigger. Owns no data.
- **Worker-side bridge body**: `attach(port)`, `handleRequest`/`respond` (the transfer), `SwUpgradeSocket`/FrameDecoder ws machinery, worker-local `portRegistry`, `getUpgradeHandlers` (stays a sync in-realm call, co-located with the registry).

Handshake, on connect and every reconnect:
1. Page `register(swUrl,{scope:'/'})`, `await ready`.
2. Page `ch = new MessageChannel()`.
3. Page→SW: `controller.postMessage({type:'lifo-connect', boxId}, [ch.port2])` (unchanged from today).
4. Page→Worker: `worker.postMessage({type:'lifo-attach', boxId}, [ch.port1])` → worker `bridge.attach(port1)` (already tears down stale port/ws on re-attach).
5. Traffic flows SW ⇄ port2/port1 ⇄ worker bridge, page out of the path. `boxId` is generated in the worker and returned in the boot RPC result (page needs it for the iframe `src=/_sw/<boxId>/<port>/`).

`__setLifoKernel` dev port bridge (`vite-plugin-port-bridge.ts`) is low priority — drop it in worker mode (the SW is the real in-page transport; `/api/proxy` is a dev/CLI fallback and the Vite node process can no longer grab a kernel ref anyway).

## Migration sequencing (each PR keeps the playground working; all gated behind `VITE_VM_WORKER`)

1. **Protocol + terminal proxy/adapter, still same-thread.** Add `protocol.ts` + `Rpc`, `WorkerTerminalProxy`, `MainTerminalAdapter`, wired over an **in-memory channel** (paired objects, no real Worker). Feed `WorkerTerminalProxy` to `Sandbox.create`/`bootShell` in place of xterm. Proves proxy + coalescing + resize caching against real examples. Ships dark. *(~80–150k tokens; natural stopping point.)*
2. **Boot orchestration behind RPC (same-thread).** Add `BoxHost` (`createSandbox`/`bootTab`/`commandsRun`/`listProcesses`/`killProcess`/`export`/`importSnapshot`/`attachSwPort`). Move `apps/playground/src/lib/shell.ts` (`bootShell` + git/ffmpeg imports), `process-inspector.ts`, and `box-snapshot.ts` core logic into the worker-side host; page keeps only DOM shells. Convert call sites in `terminal-area.tsx`/`project-example.tsx`/`interactive.tsx` to RPC proxies. Drop the now-redundant page-side `sb.commands.register('git', …)` (git already registered in `bootShell`).
3. **ServiceWorkerBridge behind the port-transfer handshake (same-thread).** Split `SwRegistrar` (page) from the bridge body (worker); implement `attachSwPort` transferring `port1`. In-memory channel exercises the exact transfer path. Verify Vite-HMR + a PGlite preview still work.
4. **Flip transport: real module Worker, `VITE_VM_WORKER=1`.** Add `vm.worker.ts`, spawn via `new Worker(new URL('./worker/vm.worker.ts', import.meta.url), {type:'module'})`. Add `worker: { format: 'es' }` to `vite.config.ts` (aliases are global `resolve.alias`, already apply). Keep in-memory path selectable for instant fallback. **Validate an actual `ffmpeg -i` run in the worker here** (biggest unknown; highest token variance). Add the `createBrowserBox` bootstrap helper here.
5. **Default flag on; delete same-thread path + `__setLifoKernel` page coupling.**

## Risks / unknowns
- **ffmpeg.wasm** (`lifo-pkg-ffmpeg`): WASM loaded from jsdelivr via `@vite-ignore` dynamic import, spawns its own nested Worker (legal). If the **multi-threaded** core is pulled it wants `SharedArrayBuffer` → COOP/COEP, which would break preview cross-origin assets. Confirm the single-threaded core is used; validate early (PR 4). git (`isomorphic-git`) is pure JS, only needs the `Buffer` global (already set in worker realm).
- **xterm write backpressure**: rAF-coalesce is mandatory; add `write(data, cb)` acks only if a runaway producer floods the channel.
- **Resize vs in-flight redraw**: one-frame `cols` staleness is acceptable (line editing tolerates reflow); push resize eagerly. Verify wide→narrow + long-line redraw.
- **SW idle eviction (~30s)**: page must re-mint the channel and re-transfer a fresh `port1` on each `controllerchange`/`lifo-need-host`.
- **Vite worker build**: must be a **module** worker for ESM + dynamic `import()`; confirm existing `manualChunks` doesn't fight worker chunking; prod `base:/playground/` must resolve the worker URL (same concern already handled for `sw.js`).
- **Persistence**: single worker now owns the IndexedDB-backed VFS (was single page) — verify `interactive.tsx` persistent kernel across reload.

## Verification
- **Node (tsx harness against `packages/core/src`)**: exercise the `Rpc` correlation + event streams over an in-memory channel; `WorkerTerminalProxy` cols/rows caching on resize; `commandsRun` streaming stdout/exit; snapshot export/import round-trip over RPC (transferable). `pnpm --filter @lifo-sh/core typecheck && build`.
- **Chrome (puppeteer-core, system Chrome, headless; console-only, no screenshots)**: with `VITE_VM_WORKER=1` — boot Interactive Shell + a preview example; type in the terminal (echo/line-edit correct), run `npm install` and confirm the **UI stays responsive** (a rAF counter keeps ticking during install → main thread not blocked); confirm a live preview renders through the SW (HMR + a PGlite/asset-heavy page for the 12MB path); multi-tab (extra terminal on the shared kernel); snapshot download→restore; `ffmpeg -i` decode. Compare against `VITE_VM_WORKER=0` for parity.
- **Regression**: full example matrix boots; process manager + Stop all; box restart.
