# Why Lifo

Coding agents write programs. Somebody has to run them: install the packages, start the dev
server, show the preview, run the tests. The usual answer is a cloud sandbox, a small VM per
user or per session, booted on demand and billed by the minute.

Lifo is the other answer for a lot of that work: run it where the user already is. A Lifo box
is a small Unix-like system written in TypeScript, so it runs inside the browser tab (or the
Node.js process) that needs it, boots in milliseconds and costs nothing to keep around.

## What it's good at

- **Previews of generated apps.** An agent writes a Vite or Expo app; the box installs and
  runs it in the user's tab and the page shows it. No server per user.
- **A shell for an agent.** One `bash` tool backed by a box: the agent runs commands, reads
  files, starts servers, and the box is thrown away afterwards.
- **Interactive docs and tutorials.** A real terminal in the page, with no backend.
- **Tests and scripts** that need a filesystem, a shell or a fresh `node_modules` without
  touching the real disk.
- **Moving between client and server.** The same box runs in the browser and in Node, and a
  snapshot moves it from one to the other.

## What it isn't

- **Not Linux.** It reimplements the Unix and Node.js APIs in TypeScript. It doesn't run
  Linux binaries, so no `apt`, `gcc` or native npm addons. WebAssembly builds of tools do
  run: esbuild, ffmpeg, and CPython through Pyodide ([Python](../build/python.md): pure-Python
  and Pyodide-built packages only, no native extensions).
- **Not a security boundary.** Programs in a box are kept apart from each other, not from
  the page or process that runs the box. See [Security and isolation](security.md).
- **Not a full Node.js.** The Node.js layer covers what real projects use (fs, http, streams,
  child_process, crypto and more) and grows as projects need more; some
  corners are missing. See [Limitations](limitations.md).

When you need real Linux, real isolation or native binaries, use a cloud sandbox. Lifo and a
cloud sandbox work well together: the box handles everything that runs fine in the tab, and
the cloud only gets the work that needs it.

## How it compares

| | Lifo | WebContainers | Cloud microVM (E2B, Vercel Sandbox, ...) |
|---|---|---|---|
| Runs in | a browser tab or your Node process | a browser tab | a VM in someone's cloud |
| Cold start | ~27 ms in a tab, under 1 ms in Node | ~6.6 s | ~150 ms to seconds, plus the network |
| Size | ~0.3 MB | ~75-85 MB | a VM |
| Needs special headers (COOP/COEP) | no | yes | n/a |
| Node.js fidelity | a compatibility layer | closer to real Node | real Node |
| Isolation | none from the host page or process | the browser's, in a worker | hardware |
| Cost | $0 | commercial license | per use |
| License | MIT | proprietary | service |

The Lifo and WebContainers cold starts are measured with `bench/` in this repo, in the same
browser; WebContainers' size and the cloud figures are the vendors' own.
See [Performance](performance.md).
