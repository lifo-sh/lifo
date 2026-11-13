# One box, in the tab and in the cloud

A Lifo box is a small computer for you or your agent: files, a shell, processes, ports and a
URL. The same box runs in a browser tab, in a Node.js process, and in Lifo Cloud, and moves
between them as a snapshot. The tab is free and private; the cloud keeps the box running when
the tab closes and plugs in the things a tab can't do, like a real Postgres or a real browser.

This page is the map: where a box runs, what changes when it moves to the cloud, and how Lifo
Cloud is put together. The pages it links to have the commands and limits.

## Three places, one box

```text diagram=places
  browser tab                     Node.js / your terminal            Lifo Cloud
 ┌──────────────────────┐        ┌──────────────────────┐        ┌──────────────────────┐
 │ @lifo-sh/core        │        │ @lifo-sh/core        │        │ @lifo-sh/core        │
 │ files in memory /    │        │ files in memory /    │        │ files in the box's   │
 │ IndexedDB            │        │ your folders mounted │        │ own database         │
 │ free, private,       │        │ npx lifo-sh, tests,  │        │ always reachable,    │
 │ gone with the tab    │        │ servers, CI          │        │ sleeps when idle     │
 └──────────┬───────────┘        └──────────┬───────────┘        └──────────┬───────────┘
            │                               │                               │
            └──────────── snapshot (tar.gz: files, env, working dir) ───────┘
                    lifo cloud push  ·  lifo cloud pull  ·  box.exportSnapshot()
```

It's the same `@lifo-sh/core` everywhere, so a command that works in the tab works in the
cloud. Nothing is rebuilt or containerized when a box moves: [`lifo cloud push`](../cloud/boxes.md)
uploads the box's files and starts the same command there.

## What swaps when a box moves to the cloud

Most of a box is JavaScript and WebAssembly, and runs the same in every host. A few things are
too heavy for a tab, or need native code, a GPU or a real kernel. For those, the box has a
**stand-in** that works anywhere, and Lifo Cloud plugs in the **real thing** as a service. Your
code calls the same command or reads the same variable either way.

```text diagram=swap
                     in a tab / Node box                    in a cloud box
                    (stand-in, in the box)            (service, next to the box)
                   ┌────────────────────────┐        ┌────────────────────────────┐
 supabase start →  │ tinbase on pg-mem      │   ⇄    │ tinbase on Postgres 17     │
 DATABASE_URL      │ (in memory; PGlite on  │        │ (one database per box,     │
                   │  request)              │        │  survives sleep)           │
                   ├────────────────────────┤        ├────────────────────────────┤
 browser       →   │ text browser, or       │   ⇄    │ headless Chromium          │
                   │ Firefox in WebAssembly │        │ (a context per box)        │
                   ├────────────────────────┤        ├────────────────────────────┤
 ffmpeg        →   │ ffmpeg.wasm            │   ⇄    │ native ffmpeg in a sandbox │
                   │ (small files)          │        │ (big files, asks first)    │
                   ├────────────────────────┤        ├────────────────────────────┤
 agent / LLM   →   │ WebLLM on your GPU     │   ⇄    │ GPU models (planned)       │
                   └────────────────────────┘        └────────────────────────────┘
```

| Capability | In the tab or a Node box | In a cloud box | Docs |
|---|---|---|---|
| Database | `supabase start` runs tinbase on pg-mem (fast, in memory); PGlite for real Postgres on request | the box's own Postgres 17 in `DATABASE_URL`; `supabase start` serves the Supabase API on it | [Databases](../cloud/boxes.md#databases) |
| Web browsing | `browser`: a text browser through lifo.sh; Firefox in WebAssembly in the split pane | a headless Chromium per account, an isolated context per box; `BROWSER_WS_ENDPOINT` for Playwright or puppeteer | [Agents](../build/agents.md) |
| Media | `ffmpeg.wasm` for small files | native ffmpeg in a locked-down container | [Services](../cloud/services.md) |
| AI models | WebLLM on the visitor's GPU | GPU models (planned) | [Agents](../build/agents.md) |
| Files | memory, IndexedDB or your mounted folders | written to the box's own database as they change | [Files](../build/files.md) |
| Network out | HTTP through the page (and a CORS proxy) | HTTP and real TCP to the public internet | [Cloud boxes](../cloud/boxes.md#other-databases-and-tcp) |
| Network in | a preview in your page; `lifo tunnel` for a public URL | the box's URL, HTTP and WebSockets | [Tunnels](../cloud/tunnels.md) |

**Services attach on first use.** A cloud box doesn't declare its services. The first
`supabase start` or database connection starts the box's Postgres; the first `ffmpeg` on a big
file sends it to the service (asking you first, because your files leave the box); the first
`browser` call starts the account's Chromium. A service follows its box: it sleeps when the box sleeps,
it is metered with the box, and it is deleted with the box.

## Where the line is

What runs inside a box and what becomes a service follows three rules:

- **Inside the box** when it is JavaScript or WebAssembly that fits a box, must also work in a
  tab, and keeps its state in files. Node.js, npm, Vite, Python, git and small media jobs live
  here.
- **A service** when it needs native code, threads, a GPU or a real kernel; when its WebAssembly
  version costs many times the native one (PGlite takes over 600 MB where native Postgres takes
  under 100 MB); or when its state should outlive the box or be shared between boxes.
- **Every service has a stand-in in the box**, so a box keeps working in a tab and offline. A
  tool without one doesn't become a Lifo service.

The list of services is short on purpose: Postgres, a browser, media tools and AI models, and
later object storage. For anything else (Redis, MySQL, a hosted Postgres, a queue), a cloud box
has real outbound TCP, so you bring your own.

## How Lifo Cloud is put together

Lifo Cloud's servers are closed source; the client side (`LifoCloud`, `lifo cloud`, the CLI) is
in this repo. This is how it behaves:

```text diagram=cloud
 your tab, terminal or agent                         visitors to a box's URL
   lifo cloud push / exec / shell                     https://my-api-tunnel.lifo.sh
            │  lifo_ key or tab token                          │
            ▼                                                  ▼
 ┌─ lifo.sh ─────────────────────┐              ┌─ ingress (tunnels) ─────────────┐
 │ accounts, keys, teams, usage  │              │ TLS, routing by box name        │
 └───────────────┬───────────────┘              └────────────────┬────────────────┘
                 │                                               │
 ┌─ a region ────▼───────────────────────────────────────────────▼────────────────┐
 │                                                                                │
 │  ┌─ your account (its own process, memory and CPU limits) ──────────────────┐  │
 │  │                                                                          │  │
 │  │   ┌─ box "my-api" ───────────┐   ┌─ box "notes" ────────────┐            │  │
 │  │   │ its own V8 isolate       │   │ its own V8 isolate       │            │  │
 │  │   │ @lifo-sh/core            │   │ @lifo-sh/core            │            │  │
 │  │   │ files in its own SQLite  │   │ files in its own SQLite  │            │  │
 │  │   └────────────┬─────────────┘   └────────────┬─────────────┘            │  │
 │  │                │ private path                 │                          │  │
 │  │   ┌────────────▼──────────────────────────────▼─────────────┐            │  │
 │  │   │ your Postgres 17: one database per box     (on demand)  │            │  │
 │  │   │ your Chromium: one context per box         (on demand)  │            │  │
 │  │   └─────────────────────────────────────────────────────────┘            │  │
 │  └──────────────────────────────────────────────────────────────────────────┘  │
 │                                                                                │
 │  other accounts: separate processes, databases and browsers                    │
 │  real containers: boxes that need native code, native ffmpeg jobs              │
 └────────────────────────────────────────────────────────────────────────────────┘
```

- **A box is a single durable instance.** Each box name maps to exactly one running instance, in
  its own V8 isolate (the boundary Cloudflare Workers use between customers), with its own
  storage. Think of a Durable Object rather than a stateless function: it has an identity, keeps
  state, holds long connections (shells, WebSockets), and sleeps when nobody uses it.
- **Files are durable as they're written.** A cloud box writes every file change to its own
  SQLite database as it happens. A crash loses at most the write in progress; sleeping saves
  nothing and waking loads nothing.
- **Accounts are separate processes.** Your boxes share a process with memory and CPU limits from
  your plan; another account's busy or crashing box can't touch yours.
- **A real container when a box needs one.** A box with native npm modules, a `Dockerfile` or
  binaries Lifo doesn't have runs in a Linux container instead (picked automatically, or with
  `--runtime container`), with the same URL, commands, database and sleep and wake. A Lifo box
  stays the default: it's far lighter and wakes faster ([Runtimes](../cloud/boxes.md#runtimes-a-lifo-box-or-a-real-container)).
- **Compute and storage are split.** The box's database lives next to it, not inside it, so it
  survives the box sleeping, restarting or being pushed again, and it's backed up on its own.
- **Network.** Boxes reach the public internet only (HTTP and TCP). Private and loopback
  addresses are refused; the only private path a box has is to its own account's services.

### A box's day

```text diagram=lifecycle
 push ──▶ boot (~110 ms) ──▶ start command runs ──▶ serving: URL, exec, shell
                                                         │
               ┌─────────────────────────────────────────┘
               │ no requests, commands or shell input for sleepAfter (default 5 min)
               ▼
            asleep: no CPU or memory; files and database kept
               │
               │ next request, exec or shell
               ▼
            wake (~110-150 ms) ──▶ start command runs again ──▶ serving
```

Memory and running processes don't survive a sleep; files and the database do. Services that
the box used (its database, its browser) start again when the box next needs them.

### Where the servers are

Lifo Cloud is regional, not edge. A box lives in one region, next to its database, and requests
from anywhere are routed to it; the edge only terminates connections and forwards them. Boxes
are single instances by design, the way most uses need them: one box per agent, per project
preview or per app. During the preview there is one region. Because a sleeping box is just its
files and its database, a box can move to another region between wakes.

## What's open

| Open source (this repo) | Closed source (Lifo Cloud) |
|---|---|
| `@lifo-sh/core`: the box, everywhere it runs | the servers that run cloud boxes |
| `LifoCloud`, `lifo cloud`, `lifo-sh cloud`: the client | accounts, metering and billing |
| the stand-ins: pg-mem/PGlite via tinbase, the text browser, ffmpeg.wasm, WebLLM | the services: Postgres, Chromium, native ffmpeg |
| the HTTP and WebSocket APIs, documented in [Cloud boxes](../cloud/boxes.md#the-api) and [Services](../cloud/services.md#the-api) | |

A box doesn't depend on Lifo Cloud: everything on this page except the services runs in your tab
or on your machine, and a pulled box keeps working there.

## See also

- [Cloud boxes](../cloud/boxes.md): commands, sleep settings, databases, limits and the API
- [Services](../cloud/services.md): tools that run on Lifo's servers, and asking before files leave the box
- [Architecture](architecture.md): inside a box (kernel, shell, Node.js layer)
- [Security and isolation](security.md): what a box protects, in a tab and in the cloud
