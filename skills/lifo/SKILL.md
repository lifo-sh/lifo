---
name: lifo
description: Use Lifo, a small Linux-like OS in TypeScript (filesystem, bash-like shell, processes, ports, Node.js runtime) that runs inside a browser tab or a Node.js process. Use it when an app needs a terminal or a shell in the browser, needs to run JavaScript/Node programs, npm or a dev server (Vite, Expo) without a server or VM, needs a cheap throwaway box for an agent's shell tool or for tests, or when the user mentions Lifo, @lifo-sh/core, @lifo-sh/ui, lifo-sh or lifo.sh.
---

# Lifo

Lifo boots a Unix-like box in about 30 ms in a browser tab and well under 1 ms in Node.js.
Inside: a bash-like shell (pipes, redirects, loops, functions, job control), ~80 commands,
`node`, `npm`, `npx`, an in-memory filesystem, processes and ports. It runs JavaScript; it does
not run Linux binaries (no apt, gcc or native npm addons). WebAssembly tools work.

Docs as Markdown: https://lifo.sh/llms.txt (index of every page). Start with the page for the
host you're working in (https://lifo.sh/docs/run/browser.md, .../run/node.md,
.../run/terminal.md); the API is in https://lifo.sh/docs/reference/sandbox.md and
https://lifo.sh/docs/reference/ui.md, previews in https://lifo.sh/docs/build/previews.md.

## Pick the host

- **In a web page**: `npm install @lifo-sh/core` (+ `@lifo-sh/ui @xterm/xterm` for a terminal).
- **In Node.js 20+** (scripts, tests, an agent's tool): `npm install @lifo-sh/core`.
- **As a shell on this machine**: `npx lifo-sh` (`--mount .` puts the current folder at `/mnt/host`).

## The API (same in the browser and Node)

```js
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create({
  cwd: '/home/user/app',
  files: { '/home/user/app/index.js': 'console.log("hi")' },
});
const { stdout, stderr, exitCode } = await box.commands.run('node index.js', { timeout: 30_000 });

await box.fs.writeFile('/home/user/a.txt', 'x');       // readFile, readdir, stat, mkdir, rm, exists, rename, cp
box.commands.register('mytool', async (ctx) => { ctx.stdout.write('ok\n'); return 0; });

await box.commands.run('node server.js &');             // servers go in the background
await box.waitForPort(3000);
const res = await box.fetch('http://localhost:3000/');  // a request INTO the box

const snap = await box.exportSnapshot({ exclude: ['node_modules'] }); // tar.gz: files + cwd + env
await (await Sandbox.create()).importSnapshot(snap);    // same format in browser, Node and CLI
```

A terminal in a page: `await Sandbox.create({ terminal: '#el' })` with
`import '@xterm/xterm/css/xterm.css'` (ui doesn't load xterm's CSS) and a container with a height.
`commands.run` output is returned to your code, not printed in that terminal.

For an agent's shell tool, one `bash` tool calling `box.commands.run(cmd, { timeout })` and
returning `stdout`, `stderr`, `exitCode` is enough; register app-specific tools as commands.

## Things that bite

- **Not a security boundary.** Code run in a box (e.g. by `node`) executes in the host's own JS
  realm: in a page it can reach the DOM, cookies and storage; in Node, the real `process` and
  `fs`. Don't run untrusted code in a box on a page or process that holds anything sensitive;
  use a sandboxed cross-origin iframe or a separate process.
- **Client only.** Never import `@lifo-sh/core` in server components or SSR; load it in an effect
  or with dynamic `import()`.
- **Next.js / Turbopack** tries to bundle native `esbuild`; alias it to a module that throws:
  `turbopack.resolveAlias: { esbuild: './src/lib/esbuild-unavailable.ts' }` (file: `throw new Error('no native esbuild')`). Lifo then uses esbuild-wasm.
- **Running Vite inside a box** needs `globalThis.Buffer ??= Buffer` (import `Buffer` from `@lifo-sh/core`) before it starts.
- **Previews** (showing a dev server from the box in an `<iframe>`) need a service worker:
  `ServiceWorkerBridge` from core plus the worker, `@lifo-sh/core/sw.js`, copied into your static
  files and served from your origin (`cp node_modules/@lifo-sh/core/sw.js public/lifo-sw.js`).
  `mountNoSwPreview` from `@lifo-sh/ui` works without one, with limits.
- **One busy box per page.** Node programs running at the same time in two boxes share the page's
  `console`/`process`, so output can cross.
- **`box.destroy()` doesn't stop running processes.** Kill them first:
  `for (const p of box.shell.getProcessRegistry().getRunning()) box.shell.getProcessRegistry().kill(p.pid)`.
- **The shell isn't bash**: brace expansion, `( )` subshells, here-docs, `read`, `local` and
  `set --` work; arrays, `[[ ]]`, `(( ))`, `trap` and word splitting of unquoted `$VARS` don't.
  `set -e` is accepted but not enforced, so chain with `&&`.
- **Network:** programs in a browser box use the browser's `fetch`, so hosts without CORS fail
  (the npm registry is fine). `localhost` from inside the box means the box's own servers.
- **Mounts** (`mounts: [{ virtualPath, hostPath, readOnly }]`) are Node-only.

## CLI quick reference

```bash
npx lifo-sh --mount .                 # shell; exits with the terminal
npx lifo-sh new --mount . --expose 5173   # keeps running; Ctrl+D detaches; box port 5173 on 127.0.0.1:5173
npx lifo-sh list | attach <id> | stop <id>
npx lifo-sh snapshot save <id> [--output f.tar.gz] | restore f.tar.gz [--mount .]
npx lifo-sh login | whoami | logout   # lifo.sh account (browser login)
npx lifo-sh tunnel 3000 --name demo   # public URL for localhost:3000 (needs login)
npx lifo-sh cloud push api --port 3000   # run this folder on Lifo Cloud (preview)
```

`git`, `vi`, `nano`, `less` and `python` are `lifo-pkg-*` packages, ready in `lifo-sh` and on lifo.sh. In your
own boxes: `npm install lifo-pkg-git` and `box.commands.register('git', (await import('lifo-pkg-git')).default)`.

**Python:** `lifo-pkg-python` gives `python3` (and `pip`): CPython on WebAssembly via Pyodide.
`import python, { pip } from 'lifo-pkg-python'; box.commands.register('python3', python)`, then
`box.commands.run('python3 script.py')`. Scripts see HOME, /tmp, the cwd and the script's folder
(copied in before each run, changes copied back). Stdlib, pure-Python wheels (`pip install`) and
Pyodide-built packages (numpy, pandas: loaded on import) work; no native extensions, subprocesses
or threads; first run downloads ~6 MB; it runs on the box's thread. Docs: /docs/build/python.md

**Lifo Cloud (preview):** `lifo cloud push <name> --port 3000 --start "node server.js"` moves a box
(as a snapshot) to the cloud, where it keeps running with a URL at `https://<name>-tunnel.lifo.sh`;
it sleeps after `sleepAfter` idle seconds (default 300; `--sleep-after 30m`, `lifo cloud config <name>
--sleep-after 2h`) and wakes on the next request; its files are saved as they change (files kept, memory not).
`lifo cloud stats <name>` / `cloud.metrics(name, '24h')` show CPU, requests, memory and uptime;
`lifo cloud usage` / `cloud.usage()` the account's metered totals.
From code: `const cloud = await LifoCloud.connect({ token }); await cloud.push(name, box, { start, port })`,
then `exec`, `logs`, `save`, `pull` (snapshot bytes for `box.importSnapshot`), and `shell(name)` for an
interactive shell (`lifo cloud shell <name>` from a terminal, like ssh; `~.` disconnects). For several
interactive shells on one local box: `box.openShell(terminal, { cwd, onExit })`. Docs: /docs/cloud/boxes.md

**Familiar commands work:** `supabase start` / `supabase db reset` run tinbase (Supabase-compatible,
:54321, reads `supabase/`); `expo start` / `npx expo start` / `npm start` run browser-metro (Expo web
preview on :8081, no node_modules needed). Each prints a one-line note saying what it ran.

Inside any box: `lifo tunnel <port>` shares the box's own port publicly, `lifo login` logs in
(paste-a-code), `lifo install <pkg>` adds Lifo packages (git, ffmpeg, nano, vi, ...), `help`
lists commands.
