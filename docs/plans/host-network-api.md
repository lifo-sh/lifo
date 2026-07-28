# Plan: Host-side network API — `sandbox.fetch()` and `sandbox.connect()`

> **Status: complete.** All three PRs shipped.
>
> | | state |
> | --- | --- |
> | **PR 1** — `dispatch.ts`, `_donePromise` on the public type, all 7 call sites converted, `PortBridge` bug fixed | **done** |
> | **PR 3 (HTTP half)** — `sandbox.fetch` + `sandbox.waitForPort` | **done** |
> | **also landed** — multi-port nosw iframe shim + Admin-UI mount (see [SW-free multi-port](#sw-free-multi-port-transport) below) | **done** |
> | **PR 2** — `ws-pipe.ts` extraction, collapsing the two duplicate upgrade sockets | **done** |
> | **PR 3 (ws half)** — `sandbox.connect(port, url)` | **done** |
>
> Verified by `packages/core/tests/kernel/dispatch.test.ts` (15),
> `packages/core/tests/sandbox/sandbox-connect.test.ts` (8, against a real in-VM `ws` server),
> `packages/core/tests/sandbox/sandbox-net.test.ts` (12),
> `packages/ui/tests/preview-nosw-resolve.test.ts` (11) and `bench/test-host-net.mjs`
> (12 checks against a real in-VM tinbase). No breaking changes.

## Context

A host program holding a `Sandbox` cannot make an HTTP request to a server running inside
the VM. There is no `sandbox.fetch()`. Today the only reachable paths are:

1. **In-VM only** — `sb.commands.run('curl localhost:3000/api')`, which round-trips through
   the shell and hands back text.
2. **`ServiceWorkerBridge` + a hand-built MessagePort stand-in** — works, and works in Node
   with no service worker (`bench/test-express-bridge.mjs` does exactly this), but it is a
   *wire protocol*, not an API: base64 bodies, `requestId` correlation, polling an array for
   the matching reply, and a class named `ServiceWorkerBridge` when no SW is involved.
3. **`kernel.portBridge.handleRequest()`** — public, closest to `fetch` in shape, and
   **silently broken for every real server** (see below).

This blocks anything that wants to drive a Lifo box from the outside: headless tests,
benchmarks, CI, and — the concrete driver — the rapidnative-website agent harness, whose
open question is *"does `@lifo-sh/core` boot in Node and reach an in-VM tinbase without a
service worker?"* The answer is yes, but only via (2), which no consumer should have to
write by hand.

## The bug this uncovers

The real dispatch contract is a three-step convention:

```ts
handler(vReq, vRes);                       // synchronous call
if (vRes._donePromise) await vRes._donePromise;   // async servers finish here
const bytes = vRes.bodyBytes ?? encode(vRes.body);
```

`ServiceWorkerBridge.handleRequest` (`kernel/network/ServiceWorkerBridge.ts:275`) does all
three, with a 120s bound. `PortBridge.handleRequest` does not:

```ts
handler(virtualReq, virtualRes);   // PortBridge.ts:88
return virtualRes;                 // PortBridge.ts:89 — never awaits _donePromise
```

So `PortBridge` returns an empty `200` before an async handler has written anything —
i.e. it is broken for Vite, Express, tinbase and every other real server, and works only
for trivial synchronous ones. It is public API.

The cause is that **`_donePromise` is not part of the exported `VirtualResponse` type**
(`kernel/index.ts:62`). It is folklore, typed ad hoc at each use site
(`VirtualResponseWithDone` in `node-compat/http.ts`, an inline cast in `curl.ts:100`), and
reimplemented in **7 places**: `ServiceWorkerBridge`, `commands/net/curl.ts`,
`node-compat/http.ts`, `kernel/network/tunnel/WebSocketTunnel.ts`, `commands/net/tunnel.ts`,
`sandbox/prune.ts`, and the playground's `lib/preview-nosw.ts`. `PortBridge` is what
happens when someone writes the dispatch without knowing the convention.

The WebSocket half has the same shape. `getUpgradeHandlers(portRegistry)`
(`node-compat/http.ts:483`) is a properly shared registry, but the socket stand-in that
drives it is duplicated: `SwUpgradeSocket` (`ServiceWorkerBridge.ts:70`) and
`VirtualUpgradeSocket` (`WebSocketTunnel.ts:30`) are near-identical `EventEmitter` fakes,
each paired with its own copy of the handshake/frame loop over the shared `ws-frame.ts`.

**So this plan is not "add a fetch method".** It is: extract the one correct dispatcher and
the one correct ws pipe, point all existing transports at them, then expose them.

## API

Two top-level methods, matching the existing top-level `attach`/`exportSnapshot` style
(namespacing under `sandbox.net` was considered and rejected — `sandbox.fetch` is the name
people will guess, and it mirrors global `fetch` closely enough to need no docs):

```js
// HTTP — a real WHATWG Response, so .json()/.text()/.arrayBuffer()/.headers come free
const res = await sandbox.fetch('http://localhost:54321/rest/v1/todos', {
  headers: { apikey: ANON_KEY },
});
const todos = await res.json();

// WebSocket — a WebSocket-like duplex into the in-VM ws server (Vite HMR, realtime)
const ws = await sandbox.connect(5173, '/hot');
ws.onmessage = (e) => console.log(e.data);
ws.send('ping');

// Both need the server to be listening first — everyone hand-rolls this loop today
await sandbox.waitForPort(3000, { timeout: 30_000 });
```

Semantics, chosen to match the service-worker transport so host and browser behave alike:

- **URL → port.** `http://localhost:<port>/path` and `http://127.0.0.1:<port>/path` map to
  the port; the host must be loopback. A bare path (`/api/todos`) is rejected — there is no
  ambient "current port" and guessing one would be worse than an error. `sandbox.fetch(url,
  {port})` is accepted as an override for callers that hold a path.
- **Unbound port → a synthetic `404` response** carrying `x-lifo: no-server`, exactly what
  the SW returns (`ServiceWorkerBridge.ts:281`) — *not* a thrown error. A rejected promise
  would be a different contract from the browser path for the same box.
- **Timeout → `504`,** default 120s, `{timeout}` overridable. The 120s figure is not
  arbitrary: an in-VM Metro cold bundle legitimately exceeds 25s, which is why the SW uses
  it.
- **Binary-safe.** `bodyBytes` is the canonical body; `res.arrayBuffer()` returns it
  untouched. The text view is best-effort UTF-8, as today.
- **`waitForPort` resolves on `portRegistry.has(port)`,** rejects on timeout. It cannot
  detect readiness beyond "bound", which is the same guarantee the SW has.

Non-goals, stated so they don't get quietly assumed: no TLS, no HTTP/2, no cookie jar, no
redirect following beyond what the caller does with a `3xx`, and no `AbortSignal` in PR 3
(cheap to add later — noted in Risks).

## Architecture

### 1. `kernel/network/dispatch.ts` — one HTTP dispatcher

```ts
export async function dispatchRequest(
  portRegistry: Map<number, VirtualRequestHandler>,
  port: number,
  req: { method: string; url: string; headers: Record<string, string>; body?: Uint8Array },
  opts?: { timeoutMs?: number },
): Promise<VirtualResponse>   // always resolves; 404/504/500 are responses, not throws
```

Owns the `_donePromise` await, the timeout race, the `bodyBytes ?? encode(body)`
normalization, and the `try/catch` → `500`. Add `_donePromise?: Promise<void>` to the
exported `VirtualResponse` interface with a comment explaining the contract, and delete
`VirtualResponseWithDone` — the convention becomes typed instead of tribal.

Then convert, in order of risk: `PortBridge.handleRequest` (**this is the bug fix**),
`ServiceWorkerBridge.handleRequest`, `curl`, `WebSocketTunnel`, `tunnel`, `prune`. Each
becomes a few lines that build a request and await the dispatcher. The playground's
`preview-nosw.ts` follows once core ships.

### 2. `kernel/network/ws-pipe.ts` — one upgrade socket + frame loop

Extract `SwUpgradeSocket` and the `onServerBytes`/`onServerFrame`/handshake-split logic into
a transport-agnostic pair:

```ts
export class VirtualUpgradeSocket extends EventEmitter { /* the shared EventEmitter fake */ }

export function openWsPipe(
  portRegistry: Map<number, VirtualRequestHandler>,
  port: number,
  url: string,
  hooks: { onOpen(): void; onMessage(data: Uint8Array, binary: boolean): void; onClose(): void },
  opts?: { protocol?: string },
): { send(data: string | Uint8Array, binary?: boolean): void; close(): void } | null
```

It fabricates the `Sec-WebSocket-Key` handshake, calls the upgrade handler, splits the 101
response, decodes frames via the existing `ws-frame.ts` (`FrameDecoder`, `encodeFrame`,
`splitHandshake`, `OPCODE`), reassembles fragments, and auto-pongs pings — all logic that
exists today inside `ServiceWorkerBridge`, just with the `postMessage`/`connId` coupling
replaced by the `hooks` callbacks. `ServiceWorkerBridge` and `WebSocketTunnel` then keep
only their message-protocol translation, and their two duplicate sockets collapse into one.

`ws-frame.ts` already has 9 passing tests, so the frame layer is not being re-litigated.

### 3. `sandbox/SandboxNet.ts` — the public surface

`sandbox.fetch` parses the URL, encodes the body, calls `dispatchRequest`, and wraps the
`VirtualResponse` in a real `Response` (`new Response(bodyBytes, {status, headers})`).
`sandbox.connect` wraps `openWsPipe` in a small `WebSocket`-shaped object
(`onopen`/`onmessage`/`onclose`/`onerror`, `send`, `close`, `readyState`) that resolves once
the handshake completes. `waitForPort` polls `portRegistry` on a short interval.

`Response` is global in Node ≥18 and every browser, so no polyfill and no new dependency.

## PR breakdown

| PR | Content | Risk |
| --- | --- | --- |
| **1** | `dispatch.ts` + `_donePromise` on the public type; convert all 7 call sites. **Fixes `PortBridge`'s empty-200 bug.** Tests: async handler, timeout → 504, unbound port → 404, binary body round-trip, and a `PortBridge` regression test that would have caught the original bug. | Low — behaviour-preserving except the fix. Touches the SW path, so the playground's Vite/Metro/tinbase examples are the smoke test. |
| **2** | `ws-pipe.ts`; collapse `SwUpgradeSocket` + `VirtualUpgradeSocket`. Tests: handshake, fragmented message reassembly, ping→pong, close propagation. | Medium — HMR is the blast radius. Verified against the Vite and Metro examples end to end, both preview engines. |
| **3** | `sandbox.fetch` / `sandbox.connect` / `sandbox.waitForPort` + types + README/docs. Tests + bench below. | Low — purely additive. |

## Verification

**Headless Vitest** in `packages/core/tests/sandbox/sandbox-net.test.ts`, against real in-VM
servers rather than stubs:

- Express: GET, POST with a JSON body (the `Content-Length` case that broke in the browser —
  `bench/test-express-bridge.mjs` exists precisely because of it), 404 from the app vs
  `x-lifo: no-server` from an unbound port, binary response integrity.
- tinbase `--engine pgmem`: `select` and `insert` over `supabase-js` pointed at
  `sandbox.fetch`. This is the rapidnative harness question answered as a test.
- Vite: `sandbox.connect(5173, '/hot')` receives an HMR update after a file edit.

**`bench/test-host-net.mjs`** — a runnable artifact mirroring `test-express-bridge.mjs`, so
rapidnative-website has something to point at rather than a test file. Prints a PASS line
like the other benches.

The existing `bench/test-express-bridge.mjs` stays as the low-level transport test; the new
bench is the API-level one. Both should pass throughout.

## SW-free multi-port transport

Landed alongside PR 1, because it is what the API was wanted for: running an Expo app **and**
tinbase **and** tinbase's Admin UI in one box with no service worker.

**The shim was single-port.** `ServiceWorkerBridge` has always routed each
`{type:'request'}` message by its own `port` field, but the injected iframe shim hardcoded
one `PORT`, so every request went to the preview server. An Expo app whose `.env` says
`EXPO_PUBLIC_SUPABASE_URL=/_sw/54321` had its REST calls sent to Metro on 8081, which 404s.
Under the service worker the same app works, because `sw.js` parses two prefix forms — one
of which exists precisely for this case.

`resolveTarget(url)` in the shim now returns *which port* serves a URL:

| URL | → |
| --- | --- |
| `/_sw/54321/rest/v1/todos` | port 54321, `/rest/v1/todos` |
| `/_sw/box_ab12/54321/…` | port 54321 |
| `http://localhost:54321/rest/v1/todos` | port 54321 |
| `/index.bundle?platform=web` | preview port |
| `http://localhost:5173/…` (the embedding page) | not tunnelled — real network |
| `blob:` / `data:` / a foreign origin | not tunnelled |

Applied to `fetch`, XHR **and** WebSocket (supabase realtime opens
`ws://localhost:54321/realtime/v1/websocket` while the preview is on 8081). **No app code
changes** — the existing templates work as written.

That last row is a trap worth keeping: during local dev the embedding page is *also* on
loopback, so a naive "loopback ⇒ in-VM" rule routes the playground's own origin (and its
`/_cors` proxy) into the port registry, where nothing is listening. The shim is given the
host's port and excludes it.

**The Admin UI.** Three things made this cheap, and one made it hard:

- `admin-ui` builds with `vite-plugin-singlefile` — one HTML document with JS and CSS
  inlined, no hashed assets. So the "ES-module chunks can't resolve inside a blob document"
  problem does not arise at all. Verified in the bench: 0 external scripts, 0 stylesheets.
- Its production `BASE` is `''`, so API calls are root-absolute and the shim already
  tunnels them.
- `ace` runs with `useWorker: false`, so nothing is fetched dynamically.
- CSP **and `x-frame-options: DENY`** are header-only with no `<meta>` equivalent. Re-serving
  the document as a blob drops both, which is what makes it embeddable — and also means the
  preview does not get the studio's hardening.

The hard part was routing: the studio reads `window.location.pathname`, which is
[Unforgeable], so the existing `routerShim` (which virtualizes `document.URL` and `history`
for Expo Router) could not reach it — every nav click stayed on the home tab. Fixed **in
tinbase** by reading `new URL(document.URL).pathname` instead; identical under normal
hosting, virtualizable when embedded. That fix needs a tinbase release before the examples
see it.

Two more things the mount got wrong and now doesn't:

- It fetched `'/'` as the entry document regardless of the requested path. tinbase answers
  `'/'` with a JSON health check, so mounting the studio blobbed the health JSON.
- The playground rendered only `previewTabs[0]` in SW-free mode, so the Studio tab was
  unreachable. Both engines now render the same tabs.

## What PR 2 actually shared (and what it didn't)

The plan assumed both transports wanted the same frame-level pipe. Only one did.

`ServiceWorkerBridge` speaks a **message**-level protocol: it hands its consumer whole,
reassembled application messages. `WebSocketTunnel` speaks a **byte**-level one — it forwards raw
socket bytes as `ws-data` and lets the relay do the framing — and it forwards the client's real
headers (minus `Origin`, deliberately). Forcing the tunnel onto `openWsPipe` would have meant
re-framing bytes it had just been handed unframed.

So the split is: the **socket stand-in** (`VirtualUpgradeSocket`) is shared by both, which is where
the actual duplication was; the **frame loop** lives in `openWsPipe` and is used by
`ServiceWorkerBridge` and `sandbox.connect`. `ServiceWorkerBridge` went from 454 to 260 lines and
`WebSocketTunnel` from 590 to 485.

Two bugs surfaced while testing `sandbox.connect` against a real in-VM `ws` server:

- **`Buffer.writeUIntBE` was missing** from the node-compat shim. `ws` uses it to write the 64-bit
  length header, so **every in-VM WebSocket message over ~64 KB threw** while smaller ones worked.
  That affects HMR payloads and realtime messages, not just this API. `writeUIntLE`, `readUIntBE`
  and `readUIntLE` were added alongside.
- **A greeting sent in the same write as the handshake could never reach an event handler.** The
  caller only receives the socket after `await`, and `resolve()` costs extra microtask ticks, so
  even a `queueMicrotask`-deferred emit ran first. Message events are now buffered until a handler
  exists and flushed when one is attached.

## Risks and open questions

- ~~**HMR is the real risk** (PR 2).~~ *Resolved: the extraction was behaviour-preserving and
  `bench/test-bm-hmr.mjs` still reports hot updates for both edits with no reload. The tunnel kept
  its own byte-level forwarding — see below.* `ServiceWorkerBridge`'s ws path is load-bearing for both
  Vite and Metro in the playground, and the nosw engine has its own known sharp edges (the
  `ws:///hot` empty-host interception, the entry-as-blob-URL mapping). Mitigation: PR 2 is
  a pure extraction with no protocol change, tested against both engines and both bundlers
  before merge. If it gets hairy, PR 3 can ship HTTP-only and `connect` can follow.
- **`AbortSignal` is deferred.** The dispatcher has no cancellation story because
  `VirtualRequestHandler` has none — a handler cannot be told to stop. Adding it means a
  convention change in the handler contract, which is a bigger conversation than this API.
  `{timeout}` covers the practical case.
- **`sandbox.fetch` is not a drop-in for a browser `fetch`** used by app code inside the
  VM. It is a *host→VM* call. In-VM `fetch` is a separate concern (`node-compat`), and the
  naming could mislead — the docs need to be explicit.
- **Concurrency is untested at depth.** The SW path serializes per requestId in practice;
  many simultaneous `sandbox.fetch` calls against one in-VM server is a case worth a test
  once the API exists, since in-VM servers are single-threaded JS.
- **`PortBridge`'s fix may surface latent bugs** in whatever depends on its current
  (wrong) synchronous behaviour. `installBrowserProxy`/`createAccessPage` and the
  `forward`/`unforward` commands are the consumers to check.
