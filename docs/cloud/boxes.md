# Cloud boxes

A box in a browser tab ends when the tab closes. A tunnel from a tab works only while the tab
is open. **Lifo Cloud** takes the box off your thread and keeps it running: you push it, it
boots on Lifo's servers in a few milliseconds, runs its start command, and its port gets a
public URL. Pull it back into a tab whenever you want.

> **Preview.** Cloud boxes are in development. The commands and API below work against a local
> cloud today; lifo.sh turns them on when the hosted cloud launches. Until then, `lifo cloud`
> says the cloud "isn't available yet".

```bash
lifo login
lifo cloud push my-api --port 3000 --start "node server.js"
#   ● my-api is running in Lifo Cloud (booted in 107 ms)
#     url:   https://my-api-tunnel.lifo.sh
```

It's the same box: the same files, environment and working directory, moved as a
[snapshot](../build/files.md). Nothing is rebuilt or containerized.


How the cloud is put together, and what a box's stand-ins (pg-mem, the text browser,
ffmpeg.wasm) become there: [One box, in the tab and in the cloud](../understand/tab-and-cloud.md).

## From anywhere a box runs

| Where | How |
|---|---|
| A box in a tab, or one started by `lifo-sh` | `lifo cloud push <name> ...` |
| Your terminal, from a folder | `npx lifo-sh cloud push <name> ...` (the folder becomes `/home/user/app`) |
| Your code, in the browser or Node.js | `LifoCloud` from `@lifo-sh/core` |

```js
import { Sandbox, LifoCloud } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.fs.writeFile('/home/user/server.js', `
  require('http').createServer((req, res) => res.end('hello from the cloud')).listen(3000);
`);

const cloud = await LifoCloud.connect({ token: 'lifo_...' }); // an API key from the dashboard
const { box: info } = await cloud.push('hello', box, { start: 'node server.js', port: 3000 });
console.log(info.url); // https://hello-tunnel.lifo.sh

await cloud.exec('hello', 'ls');                          // { stdout, stderr, exitCode }
await box.importSnapshot(await cloud.pull('hello'));      // and back into this box
```

## Commands

| | |
|---|---|
| `lifo cloud push <name> [--port N] [--start "cmd"] [--exclude a,b] [--sleep-after 10m]` | upload this box and start it. Pushing the same name again replaces it. Without `--start`, a `package.json` with a `start` script means `npm start` |
| `lifo cloud ls` | your cloud boxes: awake or asleep, URLs, storage, sleep setting |
| `lifo cloud status <name>` | awake or asleep, since when |
| `lifo cloud stats <name> [--range 1h\|6h\|24h\|7d\|30d]` | requests, CPU, memory, awake time and traffic over time ([Usage](#usage-and-sleep-settings)) |
| `lifo cloud config <name> --sleep-after 30m` | how long it may sit idle before it sleeps |
| `lifo cloud usage [--from date] [--to date]` | your account's usage per box (default: this month) |
| `lifo cloud exec <name> <command>` | run a command there; quote it if it has `;`, `|` or `&&`, or your local shell runs that part |
| `lifo cloud shell <name>` | an interactive shell there, like ssh ([Shell](#shell)) |
| `lifo cloud logs <name>` | output of the start command |
| `lifo cloud save <name>` | keep a checkpoint: a `tar.gz` copy of its files (they're always saved as they change; this is a backup) |
| `lifo cloud pull <name> [--with-data]` | bring its files into this box (and its database's data as `<name>.data.sql`). On your machine, `lifo-sh cloud pull <name>` saves `<name>.tar.gz` |
| `lifo cloud restart <name>` | start its processes again, on the same files |
| `lifo cloud rm <name>` | delete it |

`LifoCloud` has the same operations: `push`, `list`, `get`, `exec`, `shell`, `logs`, `save`,
`pull`, `restart`, `remove`, `metrics`, `events`, `update` and `usage`.

## Shell

`lifo cloud shell <name>` turns your terminal into the cloud box's, the way `ssh` does:

```bash
npx lifo-sh cloud shell my-api      # from your terminal
lifo cloud shell my-api             # from a box (a tab, or one lifo-sh started)
# Lifo Cloud · my-api · https://my-api-tunnel.lifo.sh
# user@lifo:~/app$ ls
```

It's a new shell in the running box: the same files, environment and processes as its app
(`ps` shows the start command, `curl localhost:3000` reaches it), with its own prompt and
working directory. Several shells can be open at once. Files you change are saved as you change
them, like any other change to the box.

- `exit` (or Ctrl+D at an empty prompt) ends the shell. **`~.`** at the start of a line
  disconnects, as in ssh, and `~~` types a `~`. The box keeps running either way.
- Ctrl+C and other keys go to the cloud box. Resizing your terminal resizes the shell (from
  your terminal; a box's terminal sends its size when the shell opens).
- An asleep box wakes for a shell, and stays awake while one is open.

From code, in the browser or Node.js 22+ (pass `WebSocket` from `ws` on older Node):

```js
const sh = await cloud.shell('my-api', { cols: term.cols, rows: term.rows });
sh.onData((d) => term.write(d));          // e.g. an xterm.js Terminal
term.onData((d) => sh.write(d));
term.onResize(({ cols, rows }) => sh.resize(cols, rows));
sh.onClose((code, reason) => term.write(`\r\n[${reason || code}]\r\n`));
```

`cloud.shell()` rejects if the cloud refuses (not logged in, not your box, no such box), with
the reason as its message.

## WebSockets

A WebSocket to the box's URL reaches the server in the box: Vite's live reload works on a cloud
dev server, and so do `ws` and Socket.IO servers. The server in the box does the handshake
itself, so subprotocols, binary messages and close codes are its own.

How sockets count toward [sleeping](#sleeping-and-waking):

- **What a visitor sends is activity**, like a request, and keeps the box awake.
- **An open socket by itself is not**, and neither is what your server sends down it. A server
  that broadcasts a ticker to a forgotten tab doesn't hold a box awake forever.
- **When the box sleeps, its sockets close with code 1001** ("going away"). A client that
  reconnects wakes the box, as a request would. Vite's client does; write your own to retry.

A tab left open on a Vite dev server keeps that box awake, because Vite's client pings the server
every 30 seconds. Close the tab to let it sleep.

## Databases

Every cloud box has its own Postgres 17 database. It lives outside the box, on the cloud's disk,
so it keeps its data when the box sleeps, restarts or is pushed again (a push replaces the box's
files, not its database), and it doesn't count against the box's file limit. The box finds it in `DATABASE_URL`:

```bash
echo $DATABASE_URL     # postgres://box_my_api:…@db.lifo.internal:5432/box_my_api?sslmode=disable
supabase start &       # tinbase runs on it: the Supabase API on :54321, real Postgres underneath
```

```js
// or any Postgres client: npm install pg
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
```

- **Created on first use**: the database and its role appear the first time the box connects.
  Each account has one Postgres server for its boxes, started when the first box connects and
  stopped when the account's last box sleeps (about a second the very first time, then about
  50 ms).
- **Private**: `db.lifo.internal` is reachable only from your boxes, each box's role can only
  connect to its own database, and it isn't a superuser. Queries time out after 30 s.
- **A box with its own `DATABASE_URL`** (a hosted Postgres you pushed in its env) keeps it; the
  cloud's database is then `LIFO_DATABASE_URL`.
- **Not in the box's files**: the password is set at every boot and never saved in its snapshot,
  and `lifo cloud pull` doesn't bring the database. `lifo cloud pull <name> --with-data` adds
  `<name>.data.sql`: the app's data (the `public` schema) as SQL `INSERT`s. Append it to
  `supabase/seed.sql` and tinbase loads it in a tab (pg-mem or PGlite), where the migrations
  create the tables; or load it into any Postgres with `psql -f`.
- **Backups**: the cloud dumps databases that were used, every few hours, and keeps dumps for 7
  days. `lifo cloud rm` takes a last dump before it drops the database, so a deleted box's data
  can be restored on request during that time.
- **Counted in your plan**: the database's memory and CPU are part of the account's, and its
  size is part of the box's storage.

## Other databases and TCP

```js
// a hosted database: in a cloud box, npm install pg
const { Client } = require('pg');
const db = new Client({ connectionString: process.env.MY_NEON_URL, ssl: true });
await db.connect();
```

`net.connect`, `new net.Socket()`, `tls.connect` and the in-place upgrade Postgres and MySQL use
for SSL (`tls.connect({ socket })`) open real connections from the cloud. Limits to know:

- **Public hosts only** (and the box's own [database](#databases)). `localhost`, private ranges
  (10.x, 192.168.x, ...) and cloud metadata addresses are refused with `ECONNREFUSED`. A server in
  the same box is reached the usual way, through the box's own ports.
- **TLS certificates must chain to a public authority**, and verification can't be turned off
  (`rejectUnauthorized: false` has no effect). A database whose certificate is signed by its
  provider's own CA fails the handshake; use the provider's publicly trusted endpoint, or a
  plain connection where that's acceptable.
- **Connections close when the box sleeps**, and bytes on them count as activity and as transfer.
- **Outbound only**: a box can't listen on a TCP port of its own (its HTTP port is the way in).
  No UDP.
- In a browser tab or under `lifo-sh` these modules are stubs: there is no TCP in a tab.

## Sleeping and waking

A cloud box that gets no requests, [WebSocket](#websockets) messages, commands or shell input for its `sleepAfter` (5 minutes unless
you change it) goes to sleep: it scales to zero and uses no CPU or memory while asleep, only
storage for its files. The next request to its URL, the next `exec` or a shell wakes it. Waking
takes about 110-150 ms, and the first request waits for it. On every wake the box runs its start
command again.

What is kept:

- **Files, as they were written.** A cloud box saves every change to its files as it happens
  (in its own database), so sleeping saves nothing and waking loads nothing: everything you or your
  app wrote is there, even after a crash (at most the last instant of a write in progress is lost).
  That covers your home (`/home/user`), `/root`, `/etc`, `/usr/local` (global npm installs),
  `/opt`, `/srv` and `/var`. `/tmp` and Lifo's own directories (`/bin`, `/usr/bin`, ...) start
  fresh on every wake.
- **The box's environment** (`export`ed in its start command or saved in its files, and what you
  pushed). A variable `export`ed in a shell is kept when the box goes to sleep, not after a crash.
- **The box's [database](#databases)**, always: it lives outside the box.
- **Not kept**: memory and running processes. A server that holds state only in memory starts
  empty after a wake, as it would after a restart. Write state to files or to the database and it
  survives.

## Usage and sleep settings

Each cloud box is metered minute by minute, and you can see it:

```bash
lifo cloud stats my-api --range 24h
# my-api  ● awake since 3m ago  last 24h, 5 min per cell
#
#   requests                   ▁▁▂▅█▃      1.2k
#   cpu                        ▁▁▁▃█▂      18.4 s
#   awake                      ▂▂▂██▅      2.1h
#   memory                     ▃▃▃██▅      peak 41.2 MB
#   traffic   3.4 MB out, 120 KB in
#   storage   5.1 MB
#   boots     4, last 3m ago
#   sleeps    after 5m idle
```

| | |
|---|---|
| **CPU** | time the box's JavaScript (and its garbage collection) ran, measured per box |
| **Memory** | the box's own heap plus the buffers that hold its files, peak per minute |
| **Awake** | time between a wake and the next sleep |
| **Requests, errors** | requests to its URL; errors are 5xx responses |
| **Traffic** | bytes in and out: request and response bodies, `exec` and shell traffic, pushes and pulls |
| **Storage** | the size of its files, plus its database, for every hour it exists, awake or asleep |

`lifo cloud usage` adds these up for your account (this month by default). They're what Lifo
Cloud will bill by: awake time, CPU, traffic and storage.

**Scale to zero.** `sleepAfter` is how long a box may sit idle before it sleeps: 5 minutes by
default, anywhere from 1 minute to 24 hours.

```bash
lifo cloud push my-api --port 3000 --sleep-after 30m   # on push
lifo cloud config my-api --sleep-after 2h              # later
```

A shorter window costs less awake time; a longer one means fewer cold starts (each wake takes
about 150 ms plus the start command). An idle shell counts as idle: a box that sleeps closes its
shells. Boxes that never sleep (`--sleep-after never`) will be a paid option; until then the
cloud refuses it.

## What a cloud box can do

- Everything a box can do in the browser: Node.js, npm, servers, `git`, the shell, and
  [Python](../build/python.md#in-a-cloud-box) (`python3` and `pip`; the interpreter loads in
  about 2 seconds on first use after each wake).
- **Network out**: HTTP(S) and plain TCP to the public internet. Node's `net` and `tls` are real
  sockets in a cloud box, so `pg`, `ioredis`, `mysql2` and other database clients connect to the
  box's own [Postgres](#databases) or a hosted Postgres, Redis or MySQL ([below](#other-databases-and-tcp)). Private, loopback and
  link-local addresses are refused.
- **Network in**: HTTP and WebSockets on the box's port, through its URL
  ([below](#websockets)), and [shells](#shell).
- **A real browser**: `browser` drives the box's own headless Chromium on Lifo's
  [Browser service](services.md#browser), attached on first use (about 0.3 s the first time).
  `BROWSER_WS_ENDPOINT` is its CDP endpoint, so `playwright-core`'s `connectOverCDP` and
  puppeteer work too. It closes when the box goes to sleep.
- **Credentials stay behind**: `~/.lifo` (your login) and the keys `lifo-sh` passes into a box
  are left out of every push.

## Runtimes: a Lifo box, or a real container

Most boxes run as Lifo boxes (on workerd): the same `@lifo-sh/core` as in your tab, about 9 MB
per box, waking in about 110 ms. Some projects need things a Lifo box can't do: native npm
modules (`bcrypt`, `sharp`, `better-sqlite3`), a `Dockerfile`, or binaries such as `go`, `gcc`,
`java` or `php`. Those run in a **real Linux container** instead, with everything else the same:
the URL, `lifo cloud exec` and `shell`, sleep and wake, usage, the box's Postgres database and its
browser.

```bash
lifo cloud push my-api --port 3000                      # --runtime auto: picks for you, and says why
#   ● my-api is running in Lifo Cloud (booted in 2345 ms)
#     runs:  in a container (native npm packages: bcrypt)
lifo cloud push my-api --runtime workerd                # or choose
lifo cloud config my-api --runtime container            # move a box later; its files move with it
```

`auto` (the default) picks a container when, in this order:

1. a `lifo.json` in the project says `{ "runtime": "container" }` (or `"workerd"`, which wins too);
2. the project has a `Dockerfile`;
3. it uses a native npm package (`bcrypt`, `sharp`, `canvas`, `better-sqlite3`, `argon2`, `prisma`,
   ...), or `node_modules` has compiled code (`binding.gyp`, `*.node`);
4. its start command runs a binary a Lifo box doesn't have (`go`, `cargo`, `gcc`, `make`, `java`,
   `php`, `ruby`, ...).

Otherwise it's a Lifo box.

| | Lifo box (workerd) | Container |
|---|---|---|
| What runs it | `@lifo-sh/core` in its own V8 isolate | Linux (Debian), Node.js 24, git, Python, a C/C++ toolchain |
| Wake | about 110-150 ms | about 1 s |
| Memory | about 9 MB a box at rest; heavy dev servers cost more than natively | native: the havits Vite app took 286 MB for the whole box, Vite alone 130 MB |
| Files | written to the box's own database as they change | on the container's volume |
| Native npm modules, other languages' binaries | no | yes |
| Same box in your tab | yes | the files, yes (`lifo cloud pull`); native modules only run in a container |

On a push to a container the box's `/home/user` becomes the container's, and if there's a
`package.json`, `npm install` (and `npm rebuild`) runs once in the container first: a Lifo box
can't build native modules, so they're built there. Then the start command runs.

## Isolation

Each cloud box runs in its own V8 isolate, the boundary Cloudflare Workers use between
customers. Code in a box can't see another box's memory, can't reach the cloud's internals, and
has no network but the public internet. That is stronger than a box in a tab, which shares the
page's JavaScript realm ([Security and isolation](../understand/security.md)).

A container box runs in its own container, with gVisor's kernel between it and the host's.

Each account's Lifo boxes also run in a process of their own, separate from every other account's.
Another account's busy or crashing box can't slow yours down or take it with it, and the
memory and CPU limits below are enforced on that process by the operating system. Your own
boxes share it: a box of yours that hogs the CPU slows your other boxes.

## Names and URLs

A cloud box's name is also its tunnel name: `my-api` serves at `https://my-api-tunnel.lifo.sh`.
Names follow the [tunnel rules](tunnels.md#names) and share their namespace: a name you hold
for a tunnel you can use for a cloud box, and the other way round; someone else's you can't.

## Limits during the preview

- 3 cloud boxes per account.
- Pushes up to 64 MB. Leave `node_modules` out with `--exclude node_modules` and install in
  the start command (`--start "npm install && npm start"`) if you hit it.
- 1 GB of files per box on the free plan, 10 GB on `pro` (not counting its database). A write that would go over fails with
  `ENOSPC: no space left in this box`.
- Request bodies through the URL up to 25 MB, 60 s per request (the tunnel's limits).
- 1 GB of memory and one CPU core for all of your awake boxes together on the free plan (4 GB
  and two cores on `pro`). A plain Node server box takes about 30 MB of it, a Vite dev server or
  Python 150 to 250 MB. If they go over the memory limit they are stopped: the request in flight gets a 502 that says why, the box's
  events show a sleep with reason `crashed`, and the next request starts them again with their
  files as they were. After three such crashes in a row the boxes wait before starting again,
  30 s at first.
- On the free plan, WebAssembly is compiled with V8's baseline compiler only, which keeps memory
  down but makes wasm-heavy CPU work slower: Python, esbuild and other wasm tools run about 2 to
  3 times slower than on `pro` (a pure-Python loop: 0.64 s against 0.28 s; `pip install`: 3 s
  against 1 s). JavaScript itself and serving pages aren't affected.
- When the cloud is full, waking a box answers 503 with `Retry-After`; a push is still stored
  and starts when there is room.

## The API

The cloud speaks HTTP with a `lifo_` key as a bearer token. Its address comes from the account
server's `/api/cli/config` (`cloudUrl`), or `LIFO_CLOUD_URL`.

| | |
|---|---|
| `PUT /v1/boxes/:name` | body: the snapshot (`tar.gz`); header `x-lifo-box`: JSON `{ port, start, cwd, env, sleepAfter, runtime }` (`runtime`: `auto`, `workerd` or `container`) |
| `GET /v1/boxes` | `{ boxes: [...] }`; each box has `sleepAfter`, `awake` and `since` |
| `GET /v1/boxes/:name` | `{ box, status: { awake, listening } }` |
| `PATCH /v1/boxes/:name` | `{ sleepAfter }` (seconds, 60 to 86400) and/or `{ runtime }` (`workerd` or `container`: moves the box and its files) returns `{ box }`; `box.runtime` and `box.runtimeReason` say where it runs and why |
| `DELETE /v1/boxes/:name` | |
| `POST /v1/boxes/:name/exec` | `{ cmd, cwd?, timeout? }` returns `{ stdout, stderr, exitCode }` |
| `POST /v1/boxes/:name/save` | a checkpoint (`tar.gz` copy of the files): `{ saved, snapshotBytes }` |
| `GET /v1/boxes/:name/snapshot` | the box's files as `tar.gz` (doesn't wake an asleep box) |
| `GET /v1/boxes/:name/data.sql` | its database's app data (`public` schema) as SQL `INSERT`s; 404 before the box first connects |
| `GET /v1/boxes/:name/logs` | text |
| `POST /v1/boxes/:name/restart` | |
| `GET /v1/boxes/:name/shell?cols=&rows=` | WebSocket: an interactive shell (below) |
| `GET /v1/boxes/:name/metrics?range=1h\|6h\|24h\|7d\|30d` | `{ range, step, points: [{ t, cpuMs, wallMs, requests, errors, bytesIn, bytesOut, memMB, awake }], memEstimated, uptime: { awake, since, lastWake, lastSleep, bootCount, awakeSeconds }, settings: { sleepAfter }, storageBytes }`. `step` is 60 s for 1h and 6h, 300 s for 24h, 3600 s for 7d and 30d; `awake` is the fraction of the step the box was awake |
| `GET /v1/boxes/:name/events?limit=50` | `{ events: [{ t, type, reason, detail }] }`, newest first: `boot` (reason push, request, exec, shell, restart), `sleep` (idle, push, restart, delete, evicted, ...), `push`, `restart`, `config`, `error` |
| `GET /v1/usage?from=&to=` | `{ from, to, totals: { awakeSeconds, cpuMs, requests, bytesOut, bytesIn, storageGBHours }, boxes: [{ name, ... }] }`; dates as ISO or ms, default this calendar month (UTC) |

**The shell socket.** Browsers can't set headers on a WebSocket, so the key can also go in the
subprotocols: `new WebSocket(url, ['lifo-shell', 'lifo-token.<key>'])` (the server answers
`lifo-shell`). Send JSON text frames: `{"t":"i","d":"<keys>"}` for input and
`{"t":"r","c":<cols>,"r":<rows>}` for a resize. Every frame you get is terminal output. The first
one, a banner, comes only after the key and owner check out. Close codes: 1000 when the shell
exits, 4401 not logged in, 4403 not your box, 4404 no such box, 1011 the box couldn't start a
shell.
