# Where Lifo runs

A Lifo box is a small Unix-like system: a filesystem, a bash-like shell, processes, ports
and a Node.js runtime. It's plain TypeScript, so it runs anywhere JavaScript does, and it
boots in a few milliseconds because there's nothing to emulate.

There are four ways to use one.

| | You get | Start with |
|---|---|---|
| [**In the browser**](browser.md) | A box inside your web page, driven from code, optionally with a terminal on screen | `npm install @lifo-sh/core` |
| [**In Node.js**](node.md) | The same box inside a script, a test or a server | `npm install @lifo-sh/core` |
| [**In your terminal**](terminal.md) | An interactive shell on your machine, with a folder of yours mounted in it | `npx lifo-sh` |
| **Inside a box** | Whoever is at the box's shell (you, or an agent) runs commands like on Linux | `ls`, `node`, `npm`, `lifo` |

The first three are how you *start* a box. The last is what happens once it's running, and
it's the same everywhere: a script that works in the CLI's shell works in a browser tab.

## One box, three hosts

The API is the same in the browser and in Node:

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
const { stdout } = await box.commands.run('echo hello from $(uname -s)');
console.log(stdout);
```

Once a box is running, it behaves the same in all of them. Try one:

```bash live
uname -a
echo 'console.log(`Node ${process.version}, ${require("os").cpus().length} CPU`)' > hi.js
node hi.js
ls /
```

What changes between hosts is what the box can reach:

| | Browser | Node.js | Terminal (`lifo-sh`) |
|---|---|---|---|
| Boot | ~27 ms in a tab | under 1 ms | as long as Node takes to start |
| Filesystem | in memory; IndexedDB with `persist: true` | in memory; host folders with `mounts` | in memory, with a folder of yours at `/mnt/host` (`--mount`) |
| Servers in the box | shown in an iframe through a service worker | reached with `box.fetch()` | published on a real port with `--expose` |
| Outside network | the browser's `fetch` (CORS applies) | Node's `fetch` | Node's `fetch` |
| A screen | a terminal from `@lifo-sh/ui` | none (headless) | your terminal |

The browser figure is from `bench/` (cold start to a box that can run `node` and `npm`); in
Node a box boots in about 0.35 ms once `@lifo-sh/core` is loaded.

## Moving a box between hosts

A snapshot is a `.tar.gz` of the box's files plus its working directory and environment.
The same file restores in all three places: save it from the CLI with
`lifo-sh snapshot save`, load it in a web page with `box.importSnapshot()`, or build one in
Node and ship it with your app so the page starts with `node_modules` already installed.

## Before you choose

- **A box is not a security boundary.** Programs inside it can't see each other's files or
  ports unless you share them, but their code runs in the same JavaScript realm as the page
  or process that created the box. Code that can run `node` in a box can reach the page's
  DOM and storage in a browser, and the real filesystem in Node. Run code you don't trust in
  a box on a separate origin (a sandboxed iframe) or a separate process.
- **It runs JavaScript, not Linux binaries.** Commands are TypeScript; `node` runs your
  JavaScript through a Node.js compatibility layer; WebAssembly tools (esbuild, ffmpeg) run
  as Wasm. There's no `apt`, no `gcc`, and native npm addons don't load.
