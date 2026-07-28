---
'@lifo-sh/core': minor
'@lifo-sh/ui': minor
'lifo-sh': minor
---

Host-side network API (`sandbox.fetch`), one shared in-VM dispatcher, and a multi-port SW-free preview

**`sandbox.fetch()` / `sandbox.waitForPort()`** — a host program can now make an HTTP request to a
server running inside the VM with no service worker, no port forwarding and no host networking:

```js
await sandbox.waitForPort(54321);
const res = await sandbox.fetch('http://localhost:54321/rest/v1/todos', { headers: { apikey } });
const todos = await res.json();   // a real WHATWG Response
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
buildPreviewShim({ port: 8081, hostPort: location.port })      // everything
buildPreviewShim({ port: 3000, include: ['fetch', 'xhr'] })     // HTTP only
```

Patches are `fetch | xhr | websocket | images | fonts | css`; the asset ones require `fetch` (they
re-enter through it). The routing rules live once — `resolveVmTarget` is inlined into the iframe via
`toString()`, so the sandboxed copy and the tested copy are the same function. New export paths
(`./preview-nosw`, `./preview-shims`, `./vm-routing`) don't pull in xterm. The playground's forked
copy of the transport is deleted.
