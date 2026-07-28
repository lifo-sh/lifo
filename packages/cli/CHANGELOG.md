# lifo-sh

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
