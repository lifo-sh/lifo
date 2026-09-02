# lifo-sh

## 0.10.15

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.10.15

## 0.10.14

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.10.14

## 0.10.13

### Patch Changes

- Updated dependencies [7239775]
  - @lifo-sh/core@0.10.13

## 0.10.12

### Patch Changes

- Updated dependencies [8fdc02d]
  - @lifo-sh/core@0.10.12

## 0.10.11

### Patch Changes

- Updated dependencies [2ba6a3a]
- Updated dependencies [b4398bb]
  - @lifo-sh/core@0.10.11

## 0.10.5

### Patch Changes

- Updated dependencies [b305914]
  - @lifo-sh/core@0.10.5

## 0.10.3

### Patch Changes

- Updated dependencies [6c89b00]
- Updated dependencies
- Updated dependencies [421ba7f]
  - @lifo-sh/core@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.10.2

## 0.10.1

### Patch Changes

- Fix `lifo snapshot list` finding nothing, and add tests to the CLI package

  `listSnapshots()` filtered `.zip` while `snapshot save` writes `.tar.gz`, so
  `lifo snapshot list` reported "No snapshots found" however many you had — a bug
  introduced with the format change in 0.10.0. It now matches `.tar.gz`, and takes an
  optional directory so it's testable without writing into a real home directory.

  The CLI package also has tests for the first time — **22 across 4 files**, spawning
  the built binary the way a user invokes it. That absence is why three bugs shipped:
  this one, `new Shell()` called with 4 arguments instead of 5 (which crashed every
  detached session at startup), and `ps`/`top`/`kill` handed a job table where a
  `ProcessRegistry` was expected. Each was re-introduced deliberately to confirm the
  new tests fail on it.

  Coverage: a session boots and stays alive with nothing thrown; commands run; `ps`
  lists the shell; `top`/`kill` don't throw; the host mount works both directions;
  `--expose` answers `404 x-lifo: no-server` before the in-VM server exists, then
  forwards to it on a different host port, reports each mapping, and keeps the session
  alive when one mapping can't bind; `snapshot save` writes an archive whose manifest
  carries the session's cwd and env, and that archive restores into a core box.

  `parseExpose` moved to `src/args.ts` — `index.ts` runs `main()` at import time, so
  nothing exported from it can be unit-tested.

  Two things worth knowing for anyone extending these:

  - Tests spawn `dist/index.js`, not the TypeScript source. `tsx src/index.ts` dies on
    a `browser-metro` named export that the bundle resolves fine, which also means the
    package's own `dev` script is currently broken.
  - The child's `NODE_OPTIONS` is stripped. vitest puts its module loader there, and a
    CLI booting under it resolves `browser-metro` differently and fails an ESM
    named-export check — the child has to run like a user's shell, not a test worker.

## 0.10.0

### Minor Changes

- Publish in-VM ports on the host, one portable snapshot format, and two CLI fixes

  **`exposePort()` / `lifo --expose`** — bind a real host port to a server inside the
  box. A box's ports are entries in a map, so nothing outside the process could reach
  them; in the browser that's what the service worker or blob preview is for, but on a
  host with real sockets neither is needed.

  ```bash
  lifo --expose 3000            # in-VM 3000 → http://127.0.0.1:3000
  lifo --expose 3000:5000       # in-VM 3000 → http://127.0.0.1:5000
  lifo --detach --expose 5173   # background sessions too
  ```

  Forwards HTTP through the shared dispatcher and WebSockets at the byte level (the
  client's socket goes to the in-VM server, which does its own handshake — so HMR
  works and nothing between has to parse a frame). Loopback-only by default, since a
  box runs project code. Binding doesn't require the server to exist yet: requests get
  `404` + `x-lifo: no-server` until it's live, which reads better than a refused
  connection while a dev server boots. `node:http` is injected rather than imported,
  as `NativeFsProvider` does with `fs`, so the browser bundle is unaffected.

  This is **not** `tunnel`: the in-shell `tunnel` shares a port PUBLICLY via the
  `tunnel.lifo.sh` relay, while `--expose` binds a local socket with no relay and no
  network. They compose — expose locally, then `lifo tunnel <hostPort>`.

  **One snapshot format everywhere.** There were two: core wrote a `.tar.gz` of files
  while the CLI wrote a zip wrapping a JSON-serialized VFS — because the tar had
  nowhere to keep `cwd`/`env`/`mountPath`. So a snapshot saved by the CLI could not be
  opened in the browser, and vice versa, which is a strange gap for a project whose
  point is running the same VM everywhere.

  Snapshots now carry a `lifo-snapshot.json` manifest beside the files (VFS paths all
  start with `/`, so a relative entry can't collide, and it's never restored as a
  file). `sandbox.exportSnapshot()` embeds `cwd` + `env` automatically;
  `importSnapshot()` applies them and returns the manifest. `readSnapshotMetadata()`
  reads it without a VFS, for decisions that come before you have anywhere to restore
  into. `{ metadata: false }` gives a files-only archive — which is also exactly how
  pre-manifest snapshots behave, so old `.tar.gz` files keep restoring.

  The CLI now emits and reads that archive (built by the daemon, which owns the
  filesystem). **The zip format is gone**; a zip written by lifo ≤ 0.9.0 is rejected
  with a clear message rather than half-working, and `adm-zip` is no longer a
  dependency.

  **Two pre-existing CLI bugs**, found because `--expose` couldn't be demonstrated
  without fixing them:

  - **`lifo --detach` / `lifo new` crashed on startup.** `new Shell(...)` was called
    with 4 arguments but needs 5 — `processRegistry` was missing, so `shell.start()`
    threw `Cannot read properties of undefined (reading 'spawn')`. Confirmed identical
    without any new flag.
  - **`ps` / `top` / `kill` threw** `processRegistry.getAll is not a function`: the CLI
    passed `shell.getJobTable()` where a `ProcessRegistry` was expected.

  Both are the same class of stale wiring the failing `shell.test.ts` /
  `system-extra.test.ts` suites point at (lifo#69). `Sandbox.create` had it right; the
  CLI wasn't updated when the signature changed.

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.10.0

## 0.9.0

### Minor Changes

- `sandbox.connect()` — WebSockets into the VM from the host, plus one shared ws pipe

  Completes the host network API. `sandbox.fetch()` covered HTTP; this covers the other
  half, so a test or a bench can drive an in-VM ws server (Vite/Metro HMR, supabase
  realtime) the way app code does:

  ```js
  await sandbox.waitForPort(5173);
  const ws = await sandbox.connect(5173, "/hot");
  ws.onmessage = (e) => console.log(e.data);
  ws.send("ping");
  await ws.nextMessage(); // convenient in tests
  ```

  The promise resolves only after the server's handshake, so a `send()` straight after
  `await` is safe. Text frames arrive as strings, binary as `Uint8Array`. It is
  WebSocket-_shaped_, not a real `WebSocket` — there is no socket and no URL a browser
  could open, so pretending harder would mislead.

  **One ws pipe instead of two.** `kernel/network/ws-pipe.ts` now owns the socket
  stand-in and the handshake/frame handling that `ServiceWorkerBridge` and
  `WebSocketTunnel` each carried a copy of: forging the upgrade, splitting the 101
  response from frame bytes that arrive in the same write, reassembling fragments, and
  auto-ponging. `ServiceWorkerBridge` 454 → 260 lines, `WebSocketTunnel` 590 → 485.

  The tunnel shares only the **socket**, not the frame loop — it forwards raw bytes and
  lets the relay frame them, so a frame-level API would have meant re-framing bytes it
  had just received unframed.

  Also fixes two bugs found by testing against a real in-VM `ws` server:

  - **`Buffer.writeUIntBE` was missing** from the node-compat shim. `ws` uses it for the
    64-bit length header, so **every in-VM WebSocket message over ~64 KB threw**
    (`target.writeUIntBE is not a function`) while smaller ones worked — affecting HMR
    and realtime payloads generally, not just this API. `writeUIntLE`, `readUIntBE` and
    `readUIntLE` were added with it.
  - **A server greeting sent in the same write as the handshake could never reach an
    event handler.** The caller only gets the socket after `await`, and `resolve()` costs
    extra microtask ticks, so even a deferred emit ran first. Message events are buffered
    until a handler exists and flushed when one is attached.

  New exports: `openWsPipe`, `VirtualUpgradeSocket`, and the `VmWebSocket` /
  `SandboxConnectOptions` types.

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.9.0

## 0.8.2

### Patch Changes

- Fix SW-free preview routing on a deployed origin (it only worked on localhost)

  The SW-free preview decided whether a URL belonged to the embedding page by
  comparing against `location.host` — read inside the preview document. **Inside a
  `blob:` document `location.host` is the empty string** (only `location.origin`
  survives), so every non-loopback embedder was treated as a foreign origin and its
  URLs were never tunnelled.

  That made the previous release's fix work only where the embedder happened to be
  loopback. In production:

  | deployment                      | app requests                         | before                                                                                                   |
  | ------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
  | `https://lifo.sh`               | `https://lifo.sh/_sw/54321/…`        | not tunnelled → network → a registered service worker answered it, so it looked fine but was not SW-free |
  | a host that unregisters `sw.js` | `https://<site>/_sw/<boxId>/54321/…` | not tunnelled → nothing answers → the app's API calls fail outright                                      |

  The embedder's origin is now captured in the PARENT document, where
  `location.host` is real, and passed into the shim. A URL on that origin is
  same-origin: a `/_sw/<port>/` prefix on it is ours to route, and without a prefix
  it is the embedder's own asset and goes to the real network. Loopback is still
  accepted for local dev, and a genuinely foreign origin is still rejected even if
  its path contains `/_sw/`.

  **Signature change to two exports introduced in 0.8.0:**

  ```diff
  - resolveVmTarget(url, previewPort, hostPort, locationHost)
  + resolveVmTarget(url, previewPort, hostOrigin)

  - buildPreviewShim({ port, hostPort: location.port })
  + buildPreviewShim({ port, hostOrigin: location.origin })
  ```

  Comparing by port could never distinguish a deployed embedder (no port) from an
  in-VM one, so the port form was unfixable rather than merely awkward.
  `mountNoSwPreview` and `PreviewBrowser` are unaffected — they pass this
  themselves.

- Updated dependencies
  - @lifo-sh/core@0.8.2

## 0.8.1

### Patch Changes

- Fix both preview engines against a server that sets security headers, and stop the SW-free preview depending on a service worker

  Two bugs that only surfaced once tinbase 0.10.1 shipped a hardened studio and the
  SW-free preview was driven for real.

  **A server's anti-framing headers blanked the service-worker preview.**
  `tinbase@0.10.1` began serving its studio with `x-frame-options: DENY` and a CSP
  containing `frame-ancestors 'none'`. The service worker forwards real response
  headers, so the browser refused to render the preview — while the SW-free engine
  worked, because re-serving the document as a blob drops those headers. That
  asymmetry is what made it look like the service worker had broken.

  This is not specific to tinbase: `helmet()` sets `X-Frame-Options: DENY` by
  default, so any in-VM Express app using it would blank a preview the same way.
  `stripPreviewBlockingHeaders()` now removes `x-frame-options`,
  `content-security-policy` and `content-security-policy-report-only` **on the
  preview path only** — tunnels, `curl` and `sandbox.fetch` still see exactly what
  the server sent. There is nothing for those headers to protect on a preview: the
  "server" is a JavaScript object in the very tab doing the framing. CSP goes too,
  not just its `frame-ancestors`, because preview transports inject an inline script
  into VM-served documents and a `script-src 'self'` policy blocks it.

  **The SW-free preview was quietly using the service worker.** React Native needs
  absolute URLs, so an app resolves its configured `/_sw/54321` against
  `location.origin` — which inside a `blob:` document is the EMBEDDER's origin. The
  app therefore requests `http://localhost:5173/_sw/54321/rest/v1/todos`. The
  embedder-port exclusion (which keeps the embedding page's own assets and CORS
  proxy on the real network) ran before the `/_sw/<port>/` prefix check, so that URL
  fell through to the network, where a registered service worker answered it. It
  appeared to work while masking a total failure on any browser without a
  dependable worker — the case the SW-free engine exists for.

  An explicit `/_sw/<port>/` prefix is now honoured before the embedder-port
  exclusion, and still after the foreign-origin rejection, so a hostile origin can't
  route itself into the VM by putting `/_sw/` in its path.

- Updated dependencies
  - @lifo-sh/core@0.8.1

## 0.8.0

### Minor Changes

- 1781e47: Host-side network API (`sandbox.fetch`), one shared in-VM dispatcher, and a multi-port SW-free preview

  **`sandbox.fetch()` / `sandbox.waitForPort()`** — a host program can now make an HTTP request to a
  server running inside the VM with no service worker, no port forwarding and no host networking:

  ```js
  await sandbox.waitForPort(54321);
  const res = await sandbox.fetch("http://localhost:54321/rest/v1/todos", {
    headers: { apikey },
  });
  const todos = await res.json(); // a real WHATWG Response
  ```

  The URL's port selects the in-VM server, so the host must be loopback; pass `{ port }` for a bare
  path. Transport failures are responses, not exceptions — an unbound port resolves as `404` with
  `x-lifo: no-server` and a timeout as `504`, matching the service worker so host and browser see the
  same thing for the same box. This also answers whether `@lifo-sh/core` can reach an in-VM tinbase
  from Node without a service worker: it can.

  **`kernel/network/dispatch.ts`** is now the single implementation of the `handler → await
_donePromise → bodyBytes` contract, and `_donePromise` moved onto the public `VirtualResponse` type.
  Seven places each hand-rolled it: `ServiceWorkerBridge`, `PortBridge`, `curl`, `WebSocketTunnel`,
  `tunnel`, `prune`, and the SW-free preview.

  **Bug fix:** public `PortBridge.handleRequest` never awaited `_donePromise` — it called the handler
  and returned the response object immediately, so **every async server (Vite, Express, tinbase)
  answered with an empty 200**. Only trivial synchronous handlers ever worked. Per-site behaviour is
  preserved: `curl` still exits 7 on timeout, the `tunnel` command keeps its deliberate 25s bound (it
  must answer before the relay's 30s), and `prune` still throws. Synthetic responses are tagged
  `x-lifo: no-server | timeout | handler-error` so callers can tell them from an app's own status.

  **The SW-free preview is multi-port.** The injected iframe shim hardcoded a single port, so an Expo
  app whose `.env` says `EXPO_PUBLIC_SUPABASE_URL=/_sw/54321` had its REST calls sent to Metro on 8081.
  `resolveVmTarget` now resolves `/_sw/<port>/…`, `/_sw/<boxId>/<port>/…` and `http://localhost:<port>/…`
  across `fetch`, XHR **and** WebSocket (supabase realtime), with **no app-code changes**. The
  embedding page's own port is excluded — in local dev the embedder is on loopback too, and routing its
  origin into the port registry hits nothing.

  **tinbase's Studio now mounts SW-free** at `/_/`. The mount also fetches the requested entry path
  instead of always `/` (tinbase answers `/` with a JSON health check, so mounting the studio used to
  blob the health JSON), and both preview engines now render the same tabs — the SW-free path rendered
  only the first, hiding the Studio entirely. Requires `tinbase@^0.10.1`, which the templates now pin.

  **The iframe patches are modular** (`@lifo-sh/ui/preview-shims`, `@lifo-sh/ui/vm-routing`) so other
  embedders can compose them:

  ```js
  buildPreviewShim({ port: 8081, hostPort: location.port }); // everything
  buildPreviewShim({ port: 3000, include: ["fetch", "xhr"] }); // HTTP only
  ```

  Patches are `fetch | xhr | websocket | images | fonts | css`; the asset ones require `fetch` (they
  re-enter through it). The routing rules live once — `resolveVmTarget` is inlined into the iframe via
  `toString()`, so the sandboxed copy and the tested copy are the same function. New export paths
  (`./preview-nosw`, `./preview-shims`, `./vm-routing`) don't pull in xterm. The playground's forked
  copy of the transport is deleted.

### Patch Changes

- Updated dependencies [1781e47]
  - @lifo-sh/core@0.8.0

## 0.7.1

### Patch Changes

- node: fix ESM transform crashing on a regex literal inside a `${…}` template expression

  `npx tinbase --engine pgmem` — the backend behind both Supabase examples — died on startup with:

  ```
  TypeError: [/…/node_modules/tinbase/dist/index.js] Cannot read properties of undefined (reading 'slice')
  ```

  The ESM→CJS string masker was at fault, not tinbase (which runs fine on the host on both 0.8.1 and
  0.10.0). `scanBracedExpr` called the three-parameter `isRegexStart(prevChar, prevIdx, src)` with two
  arguments:

  ```js
  const kind = isRegexStart(src, i); // src lands in prevChar, i in prevIdx, src is undefined
  ```

  `prevChar` then held the entire source, so the `/[A-Za-z_$]/` keyword check passed on any file
  containing a letter and fell through to `src.slice(…)` on `undefined`. Every `/` inside a `${…}`
  template expression — division or regex — threw.

  Only the pgmem path happened to contain that shape, which is why just that engine broke:
  `pg-mem/index.js`, `tinbase/dist/db/pgmem-engine.js` and `tinbase/dist/db/schema-diff.js` all build
  SQL with `` `${l.replace(/'/g, "''")}` ``. A sweep of `transformEsmToCjs` over all 175 files in the
  example's `node_modules` fails on exactly those three before the fix and none after.

  `scanBracedExpr` now tracks `prevChar`/`prevIdx` the same way `maskStringLiterals` does — comments
  transparent, a string or regex literal reported as a value — and passes all three arguments.

  **Debugging note for next time:** the error names the _parent_ module being executed, not the module
  whose transform threw. `tinbase/dist/index.js` was never the problem.

- Updated dependencies
  - @lifo-sh/core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [d6084b5]
  - @lifo-sh/core@0.7.0

## 0.6.8

### Patch Changes

- Updated dependencies [fec16db]
  - @lifo-sh/core@0.6.8

## 0.6.7

### Patch Changes

- Republish so the packages install from npm.

  Both were last published with `npm publish`, which does not rewrite the `workspace:*` protocol the
  way pnpm does. The tarballs therefore carried it literally:

  - `lifo-sh` shipped `"@lifo-sh/core": "workspace:*"` as a dependency
  - `@lifo-sh/core` shipped `"@lifo-sh/ui": "workspace:*"` as a peer dependency

  Either one fails a default `npm install` with `EUNSUPPORTEDPROTOCOL: Unsupported URL Type
"workspace:"`. The peer was the less obvious of the two — it is still a hard failure, and it only
  went unnoticed because the consumers that had it installed set `legacy-peer-deps=true`.

  No source change; this release exists only to ship manifests pnpm has resolved to real versions.
  A `prepublishOnly` guard now refuses to publish through npm so it cannot recur.

- Updated dependencies
  - @lifo-sh/core@0.6.7

## 0.6.6

### Patch Changes

- Updated dependencies [9e183ab]
  - @lifo-sh/core@0.6.6

## 0.6.5

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.6.4

## 0.6.0

### Minor Changes

- Version alignment across the linked `@lifo-sh` suite (no functional changes).

## 0.3.0

### Minor Changes

- **Host filesystem mounting** -- `--mount <path>` / `-m <path>` flag to mount a real host directory at `/mnt/host`, enabling direct disk I/O with no memory limits on file size
- **Temp sessions** -- When no `--mount` flag is provided, a temporary directory is created and cleaned up on exit
- **PWD defaults to mount** -- Shell starts in `/mnt/host` for immediate access to mounted files

## 0.2.0

### Minor Changes

- Initial public release of Lifo packages -- a Linux-like OS running natively in JavaScript.
