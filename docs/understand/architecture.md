# Architecture

A Lifo box is an ordinary JavaScript object graph: a kernel with a filesystem and a network
stack, a shell, a table of commands and a process registry. There's no emulator: when a
program in the box reads a file, a TypeScript function reads a JavaScript object; when it
opens a port, a handler goes into a map. That's why a box boots in under a millisecond.

This page is the inside of one box. For where a box runs (tab, Node.js, Lifo Cloud) and what
swaps for a service when it moves to the cloud, see
[One box, in the tab and in the cloud](tab-and-cloud.md).

```
 terminal (@lifo-sh/ui, xterm.js)     or     your code (box.commands.run)
                      │                                  │
 ┌────────────────────▼──────────────────────────────────▼──────────────┐
 │ shell        lexer → parser → interpreter: pipes, redirects, loops,   │
 │              functions, jobs, globbing, history, completion           │
 ├───────────────────────────────────────────────────────────────────────┤
 │ commands     ~80 built in (ls, grep, sed, awk, tar, curl, ...),       │
 │              node, npm/npx, lifo packages, your registered commands  │
 ├───────────────────────────────────────────────────────────────────────┤
 │ node-compat  fs, path, http, stream, child_process, crypto, ...      │
 │              on top of the kernel, plus wasm tools (esbuild, ...)     │
 ├───────────────────────────────────────────────────────────────────────┤
 │ kernel       filesystem (VFS)  ·  processes  ·  network stack  ·      │
 │              services          ·  persistence (IndexedDB)             │
 ├───────────────────────────────────────────────────────────────────────┤
 │ host         a browser tab or a Node.js process: fetch, timers,       │
 │              IndexedDB, service workers, node:fs (for mounts)         │
 └───────────────────────────────────────────────────────────────────────┘
```

## The kernel

**Filesystem.** An in-memory tree of directories and files with Unix semantics: paths,
permissions, symbolic links (no hard links), timestamps. A few paths are generated on read instead
of stored: `/proc` (uptime, memory, CPU, version) and `/dev` (`null`, `zero`, `random`,
`urandom`). Other filesystems can be mounted at a path: in Node, a folder on your disk
(`mounts`, `mountNative`); `lifo-sh` mounts your folder at `/mnt/host`. With
`persist: true`, the tree is saved to IndexedDB and restored on the next visit. A folder can
also live in SQLite, written through as it changes ([Files in SQLite](../build/files.md#files-in-sqlite)).

```bash live
ls /
cat /proc/version
cat /proc/uptime
ls -l /dev
```

**Processes.** Every command that runs is a process with a PID, arguments, a working
directory, an environment and an exit code, in a process registry that `ps`, `kill`, `jobs`,
`fg` and `bg` read. Processes are asynchronous functions on the host's event loop, not
threads: they run concurrently while they wait (for I/O, timers, the network) and take turns
on the CPU.

**Network.** A port table maps port numbers to the handlers of servers running in the box.
When a program calls `http.createServer().listen(3000)`, the handler goes into the table on
port 3000; a request to `localhost:3000` from inside the box goes straight to it. Requests
from outside the box reach the same table through one of several doors:

| From | Through |
|---|---|
| your code | `box.fetch()`, `box.connect()` |
| an `<iframe>` in the page | a service worker that forwards the iframe's requests to the page (previews) |
| your machine | `lifo-sh --expose`, which listens on a real port |
| the internet | `lifo tunnel`, through the lifo.sh tunnel server |

WebSockets go through the same doors, which is how a dev server's hot reload works in a
preview.

**Services.** `systemctl` starts and stops long-running programs defined in unit files, for
the boxes that need a database or a server running from boot.

## The shell

A bash-like shell: a lexer and a parser build a syntax tree, and an interpreter runs it.
Pipes, redirects (`>`, `>>`, `<`, `2>`, `2>&1`, `&>`), `&&`, `||`, `;`, background jobs,
`if`/`for`/`while`/`until`/`case`, functions, variables and `${VAR:-default}`, command
substitution, globs and `~`, aliases, history with search, and tab completion. It reads `/etc/profile` and `~/.bashrc` at start. It is not bash: rarely used
syntax may be missing.

## Commands

A command is an `async (ctx) => exitCode` function that gets its arguments, environment,
working directory, standard streams, an abort signal and the filesystem. The built-in ones
cover files, text, archives, networking and the system. More come from three places:

- **Lifo packages**, installed with `lifo install <name>`: `git`, `ffmpeg`, `nano`, `vi`,
  `less`, `man` and others, some of them WebAssembly builds. `git`, `vi`, `nano` and `less`
  come ready in `lifo-sh` and in the boxes on lifo.sh; each loads the first time it runs.
- **npm**: `npm install -g` puts a package's `bin` entries on the `PATH`, as on Linux.
- **Your code**: `box.commands.register(name, fn)`.

## Node.js

`node` runs JavaScript with a Node.js compatibility layer: `require` and `import` resolve
from `node_modules` in the box's filesystem, and the built-in modules (`fs`, `path`,
`http`, `https`, `net`, `stream`, `events`, `child_process`, `crypto`, `os`, `url`, `zlib`,
`readline`, `worker_threads`, `assert`, `perf_hooks` and more) are implemented on top of the kernel. `fs` is the
box's filesystem; `http.createServer` listens in the box's port table; `child_process` runs
commands in the box's shell. Packages that need native code get WebAssembly stand-ins where
one exists (esbuild, SWC, Rollup's parser, Tailwind's oxide), which is what lets Vite
and Expo's Metro run.

`npm install` fetches packages from the npm registry and unpacks them into the box's
`node_modules`.

```bash live
mkdir -p app && cd app && npm init -y > /dev/null
npm install left-pad
node -e "console.log(require('left-pad')('lifo', 8, '.'))"
```

## The pieces you import

| Package | What's in it |
|---|---|
| `@lifo-sh/core` | the kernel, shell, commands and Node.js layer, and the `Sandbox` API over them |
| `@lifo-sh/ui` | an xterm.js terminal, a file explorer, a preview browser |
| `lifo-sh` | the CLI: boxes on your machine, snapshots, login and tunnels |
