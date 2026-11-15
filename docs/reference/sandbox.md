# Sandbox API (@lifo-sh/core)

```js
import { Sandbox } from '@lifo-sh/core';
const box = await Sandbox.create(options);
```

The same API in the browser and in Node.js 20+. `Sandbox` runs the box in the realm that creates
it. In a browser page that is the page itself, so code in the box can read the page's DOM, storage
and session: use it for code you trust. For anything else in a browser, use
[`WorkerSandbox`](#workersandbox-a-box-in-a-web-worker), which runs the same box in a Web Worker
([Security and isolation](../understand/security.md)).

## Sandbox.create(options?)

| Option | Type | |
|---|---|---|
| `cwd` | `string` | starting directory (default `/home/user`) |
| `env` | `Record<string, string>` | extra environment variables, merged over the defaults |
| `files` | `Record<string, string \| Uint8Array>` | files to write at boot; parent directories are created |
| `persist` | `boolean` | browser only: keep the filesystem in IndexedDB across visits (default `false`) |
| `terminal` | `string \| HTMLElement \| ITerminal` | a CSS selector or element to put an xterm.js terminal in (needs `@lifo-sh/ui`), or your own terminal; without it the box is headless |
| `mounts` | `{ virtualPath, hostPath, readOnly?, fsModule? }[]` | Node only: host folders to show in the box |
| `auth` | `{ baseUrl, getToken }` | lend the box a login: `lifo whoami`, `lifo tunnel` and `lifo cloud` in the box act as that account. `getToken()` returns a `lifo_` token or `null`; it's called the first time a command needs one, and the result is reused until a minute before it expires. The token never goes into the box's env or files |
| `realm` | `'page'` | says the in-page box is intended. It changes nothing about how the box runs; it hides the one-time console note `Sandbox.create` prints in a browser page |
| `net` | `{ connect(opts) }` | real outbound TCP for the box's `net` and `tls` modules, from a host that has it. `connect({ host, port, tls?, servername? })` returns a socket: `{ opened, onData(cb), onClose(cb), write(bytes), end(), destroy(), startTls?() }`. Without it (the default, and always in a browser tab) those modules are stubs. Lifo Cloud passes one built on workerd's `connect()`; the host decides which addresses a box may reach |

Default environment: `HOME=/home/user`, `USER=user`, `HOSTNAME=lifo`, `SHELL=/bin/sh`,
`PATH=/usr/bin:/bin`, `TERM=xterm-256color`, `EDITOR=nano`.

## Properties

| | |
|---|---|
| `box.commands` | run and register commands (below) |
| `box.fs` | the filesystem (below) |
| `box.env` | the environment object; changes apply to later commands |
| `box.cwd` | the working directory; assignable |
| `box.kernel` | the kernel: `vfs`, `portRegistry`, `processRegistry`, ... (advanced) |
| `box.shell` | the shell: `getProcessRegistry()`, `execute()`, ... (advanced) |

## box.commands

**`run(line, options?) → Promise<{ stdout, stderr, exitCode }>`**: runs a shell line (pipes,
redirects, `&&`, loops, `&` for background) to completion.

| Option | |
|---|---|
| `cwd` | working directory for this run |
| `env` | extra variables for this run only; the previous values come back afterwards |
| `stdin` | text to feed the command |
| `onStdout(chunk)`, `onStderr(chunk)` | streaming output |
| `timeout` | milliseconds; then the command is stopped and `exitCode` is 130 |
| `signal` | an `AbortSignal` that stops the command |

**`register(name, command)`**: adds a command. A command is
`async (ctx) => exitCode`, where `ctx` has `args`, `env`, `cwd`, `vfs`, `stdin`
(`read()`, `readAll()`), `stdout` and `stderr` (`write()`), and `signal`.

## box.fs

All methods are async.

| | |
|---|---|
| `readFile(path)` | contents as a string |
| `readFile(path, null)` | contents as a `Uint8Array` |
| `writeFile(path, content)` | string or bytes |
| `writeFiles([{ path, content }])` | many at once; parent directories must exist |
| `readdir(path)` | `[{ name, type: 'file' \| 'directory' }]` |
| `stat(path)` | `{ type, size, mtime }` |
| `exists(path)`, `mkdir(path, { recursive })`, `rm(path, { recursive })`, `rename(from, to)`, `cp(from, to)` | |

## Network

| | |
|---|---|
| `fetch(url, init?) → Response` | an HTTP request to a server in the box. `url` is `http://localhost:<port>/...`, or a path with `init.port`. `init`: `method`, `headers`, `body`, `timeout` (ms, default 120 000). Unbound port: 404 with `x-lifo: no-server`; no answer in time: 504. |
| `connect(port, path?, { protocol, timeout }) → WebSocket-like` | a WebSocket to a server in the box; resolves after the handshake. `send`, `close`, `onmessage`, `addEventListener`; text frames arrive as strings, binary as `Uint8Array`. |
| `waitForPort(port, { timeout }?)` | resolves when something listens on `port` |

## Snapshots

| | |
|---|---|
| `exportSnapshot({ exclude?, metadata? }) → Uint8Array` | a `.tar.gz` of the files plus a manifest (`cwd`, `env`). `exclude`: names to skip anywhere in the tree. `metadata: false`: files only. |
| `importSnapshot(bytes) → manifest \| null` | restores files, then the manifest's `cwd` and `env` |

## Host folders (Node)

| | |
|---|---|
| `mountNative(virtualPath, hostPath, { readOnly?, fsModule? })` | show a host folder at `virtualPath` |
| `unmountNative(virtualPath)` | remove it |

## Lifecycle

| | |
|---|---|
| `attach(target, { fontSize }?)` | show the box's shell in a terminal. `target` is a CSS selector or element (an xterm.js terminal from `@lifo-sh/ui`) or your own `ITerminal`. The terminal and `commands.run()` share one shell: files, variables, working directory and processes. Attaching again moves the shell to the new terminal. |
| `detach()` | disconnect the terminal (removing the one `attach` created); the box keeps running headless |
| `destroy()` | marks the box as gone. Programs still running aren't stopped; kill them first via `box.shell.getProcessRegistry()` (`getRunning()`, `kill(pid)`). |

## WorkerSandbox (a box in a Web Worker)

`WorkerSandbox.create(options)` runs the box in a Web Worker, so code in it can't reach the page
([Security and isolation](../understand/security.md#a-box-in-a-web-worker)). The worker's entry
calls `serveSandbox(self, { setup(box, extra) {...} })`, where `setup` registers commands and
packages that run in the box. A command that needs the page (the DOM, a canvas, the GPU) is a
host command, registered on the page side (below).

| Option | |
|---|---|
| `worker` | the worker running `serveSandbox` (`new Worker(url, { type: 'module' })`), any `MessagePort`, or a function returning one |
| `host` | `{ origin, path?, timeoutMs? }`: run the box on another origin instead (a different site): a hidden, sandboxed iframe loads `origin + path` (default `/box-host`), whose page calls `serveBoxFrame()`, and the box is served on the port it hands over. Takes precedence over `worker` |
| `env`, `cwd`, `files`, `persist` | as for `Sandbox.create` |
| `terminal` | an element or selector (an xterm.js terminal is made in the page) or your own `ITerminal`; output and keystrokes cross as messages |
| `auth` | a `BoxAuth`; `getToken()` runs in the page, and only the token crosses |
| `setup` | any structured-cloneable value, passed to the worker entry's `setup(box, extra)` |

The box has the same `commands.run` (with `onStdout`/`onStderr`, `signal`, `timeout`, `stdin`),
`fs`, `cwd`, `attach`/`detach`, `fetch`, `waitForPort`, `exportSnapshot`/`importSnapshot`, plus
`env` (as of the last call; `getEnv()`, `setEnv(key, value)`), `ports()`, `processes()`,
`busy()`, `resize(cols, rows)`, and `servePreviews(port)`: pass one end of a channel to the preview
service worker, and preview requests are answered inside the box's worker. `kernel` and `shell`
stay in the worker. `destroy()` terminates the worker, which stops every process at once
(and removes the iframe of a box on another origin). Buffers (snapshots, binary files) are
transferred, not copied.

### Host commands

**`commands.register(name, command) → Promise`** on a `WorkerSandbox` adds a host command: the
command runs in the page, and the box gets a command of that name (in `/usr/bin`, usable in its
shell, pipes and scripts) that forwards each call to it. It resolves once the box has it.

```js
await box.commands.register('page-title', async (ctx) => {
  ctx.stdout.write(document.title + '\n'); // runs in the page: the DOM is here
  return 0;
});
await box.commands.run('page-title | tr a-z A-Z'); // the box reaches the page only this way
```

`ctx` is a command context whose `args`, `env`, `cwd`, `signal` and `stdin` come from the box
(stdin is read from the box as the command asks for it), and whose `stdout` and `stderr` stream
back to it. `executeCapture(line)` and `executeCaptureResult(line)` run a line in the box's shell.
`ctx.fs` is the box's filesystem (async, as `box.fs`). `ctx.vfs` stands in for the box's
synchronous VFS: its writes (`writeFile`, `appendFile`, `mkdir`, `unlink`, `rename`, `copyFile`,
`touch`, `rmdir`, `rmdirRecursive`, `symlink`, `chmod`) are sent to the box and land before the
command exits; its reads throw, so use `ctx.fs`. When the box stops the command (Ctrl+C, a
`timeout`, a `signal`), `ctx.signal` aborts. The return value is the exit code; a thrown error
prints `name: message` to stderr and exits 1. `setRawMode` isn't available.

Host commands are how the box reaches the page, so treat them as an API the box can call: the
box gains exactly the commands registered this way and nothing else, and code in the box can call
them with any arguments and stdin. Check what they're given as you would input from a user.
Commands that don't need the page belong in the worker's `setup`, where they run inside the box.

A box on another origin also has `origin` (the box origin; `null` otherwise) and
`servePreviewsOnOrigin()`, which serves its previews from the box origin's service worker and
returns `{ boxId, base }`: a preview of port 3000 is at `base + '3000/'`. It reconnects by itself
when the service worker restarts.

### On the box origin

| | |
|---|---|
| `serveBoxFrame({ allowedOrigins, createWorker, serviceWorker? })` | in the host page: answers only a parent page from `allowedOrigins`, once; starts the worker; hands the parent the box's port and a control port; registers `serviceWorker` (`{ url, scope }`) for previews |
| `serveSandboxWhenConnected(self, options)` | in the box's worker: serve the box on the port the host page hands over (same options as `serveSandbox`) |
| `openBoxFrame({ origin, path?, timeoutMs?, container? })` | the page side that `WorkerSandbox.create({ host })` uses; returns the port and control |

## Other exports

| | |
|---|---|
| `ServiceWorkerBridge` | previews of servers in the box; see [Servers and previews](../build/previews.md) |
| `Buffer` | Node's `Buffer`, as the box uses it |
| `runTunnel`, `createVmForwarder` | the tunnel client used by `lifo tunnel` |
| `createPkce`, `loginUrl`, `exchangeCode`, `fetchMe`, `revokeToken`, `fetchCliConfig` | the lifo.sh login used by `lifo login` |
| `Kernel`, `Shell`, `createDefaultRegistry`, ... | the parts `Sandbox` is built from, for custom setups |
