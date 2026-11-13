# Lifo in the browser

`@lifo-sh/core` boots a box inside your web page in a few tens of milliseconds. You can drive
it from code (headless), or put a terminal on the page so people can type into it, or both.

```bash
npm install @lifo-sh/core
npm install @lifo-sh/ui @xterm/xterm   # only if you want a terminal on screen
```

Supported browsers: Chrome and Edge 110+, Firefox 110+, Safari 16.4+.

## Headless: run commands from code

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();

await box.fs.writeFile('/home/user/hello.js', 'console.log("hello from a box in this page")');
const { stdout, stderr, exitCode } = await box.commands.run('node hello.js');
console.log(stdout, exitCode);   // hello from a box in this page 0
```

`commands.run` takes a full shell line (pipes, `&&`, redirects, `$(...)`) and resolves when
it finishes. Pass `onStdout` / `onStderr` to stream output, `signal` or `timeout` to stop it,
`cwd` and `env` for the one command, and `stdin` to feed it input.

A command that should keep running, like a server, goes in the background:

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.fs.writeFile('/home/user/server.js',
  `require('http').createServer((req, res) => res.end('hi ' + req.url)).listen(3000)`);
await box.commands.run('node server.js &');
await box.waitForPort(3000);

const res = await box.fetch('http://localhost:3000/ping');   // a request into the box
console.log(await res.text());                                // hi /ping
```

`box.fetch` talks to a server inside the box directly. It's how your page's code calls it.
To show the server to a person in an `<iframe>` (a Vite app, an Expo app), see
[Servers and previews](#servers-and-previews) below.

## With a terminal on the page

Give `Sandbox.create` an element (or a CSS selector) and it puts an xterm.js terminal there,
running the box's interactive shell:

```html
<div id="terminal" style="height: 360px"></div>
```

```js live
import { Sandbox } from '@lifo-sh/core';
import '@xterm/xterm/css/xterm.css';   // xterm's own styles; @lifo-sh/ui doesn't load them

const box = await Sandbox.create({ terminal: '#terminal' });
```

The container needs a height; the terminal fills it and refits when it resizes.

The terminal and `commands.run` share the box (same files, same processes, same ports) but
not the screen: output from `commands.run` comes back to your code and isn't printed in the
terminal. To show a command as if someone typed it, write the keystrokes into the terminal
instead.

To choose the font size, colors or renderer, create the terminal yourself and pass it in:

```js live
import { Sandbox } from '@lifo-sh/core';
import { Terminal } from '@lifo-sh/ui';
import '@xterm/xterm/css/xterm.css';

const terminal = new Terminal(document.getElementById('terminal'), {
  fontSize: 13,
  webgl: false,                          // DOM renderer: no WebGL context needed
  theme: { background: '#07081a', foreground: '#e6e6ef' },
});
const box = await Sandbox.create({ terminal });
```

Anything that implements `ITerminal` (`write`, `writeln`, `onData`, `cols`, `rows`, `focus`,
`clear`) works too, if you'd rather render output yourself.

A box that started headless can get a terminal later, for example after your code has set it
up, or when someone clicks "Open terminal". `box.detach()` takes it away again:

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.commands.run('mkdir -p ~/app && echo "ready" > ~/app/status && cd ~/app');
await box.attach('#terminal');           // the same shell: try `cat status` in it
```

## git, vi and nano

A box from `@lifo-sh/core` has the core commands. `git`, `vi`, `nano` and `less` are separate
packages, so core stays small; add the ones you want:

```js
import { Sandbox } from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';     // npm install lifo-pkg-git
import viCommand from 'lifo-pkg-vi';       // npm install lifo-pkg-vi

const box = await Sandbox.create({ terminal: '#terminal' });
box.commands.register('git', gitCommand);
box.commands.register('vi', viCommand);
```

To load one only when it's first used, register a function that imports it:
`box.commands.register('git', async (ctx) => (await import('lifo-pkg-git')).default(ctx))`.

## Starting with files

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create({
  cwd: '/home/user/app',
  files: {
    '/home/user/app/package.json': JSON.stringify({ name: 'app', scripts: { start: 'node index.js' } }),
    '/home/user/app/index.js': 'console.log("ready")',
  },
});
console.log((await box.commands.run('npm start')).stdout);
```

A whole project, `node_modules` included, can come from a snapshot you built ahead of time:

```js
const snapshot = new Uint8Array(await (await fetch('/snapshots/app.tar.gz')).arrayBuffer());
await box.importSnapshot(snapshot);
```

A snapshot is how you skip `npm install` in the visitor's browser: install once (in Node or
with the CLI), export the box, serve the `.tar.gz` with your site. See
[Where Lifo runs](README.md#moving-a-box-between-hosts).

## Keeping files across reloads

```js
const box = await Sandbox.create({ persist: true });
```

With `persist: true` the filesystem is saved to IndexedDB and restored on the next visit, per
origin. Without it, a box starts fresh every time.

## Network

Programs in a box use the browser's `fetch`, so `curl https://example.com` and `npm install`
work, within the browser's rules: requests to servers that don't send CORS headers fail.
`npm install` works because the npm registry and the CDNs Lifo uses do send them.

Some hosts are routed through a CORS proxy for Node programs in the box (`node`, and tools
like `create-expo-app` that use `http`/`https`): by default the Expo hosts `api.expo.dev`,
`exp.host` and `u.expo.dev`. Set these in the box's environment to change that:

- `LIFO_CORS_PROXY`: the proxy, as a URL prefix the encoded target is appended to (default
  `http://localhost:3005/_cors?url=`, the local relay in `apps/tunnel-server`)
- `LIFO_CORS_PROXY_HOSTS`: the comma-separated hosts to send through it

Requests to `localhost` from programs in the box go to the box's own servers, as on a real
machine.

## Servers and previews

A dev server in a box (`npm run dev`, `vite`, `next dev`, `expo start`) listens on a port
inside the box. To show it in an `<iframe>`, the page registers a service worker that answers
the iframe's requests from the box. `@lifo-sh/core` has the page side
(`ServiceWorkerBridge`); the worker itself ships as `@lifo-sh/core/sw.js`, which you copy into
your static files and serve from your own origin. The setup is in
[Servers and previews](../build/previews.md).

If you can't use a service worker, `mountNoSwPreview` from `@lifo-sh/ui` renders a preview
without one, with some limits.

## With a framework

Load Lifo on the client only; it needs `window`.

**Next.js.** Import it inside an effect or with a dynamic `import()`, never at the top of a
server component. Turbopack also tries to bundle Node's native `esbuild` package, which Lifo
only loads when running under Node. Alias it to a module that throws, and Lifo falls back to
`esbuild-wasm`:

```ts
// next.config.ts
export default {
  turbopack: { resolveAlias: { esbuild: './src/lib/esbuild-unavailable.ts' } },
};

// src/lib/esbuild-unavailable.ts
throw new Error('native esbuild is not available in the browser');
```

**Vite inside the box.** If the box runs Vite (as opposed to your page being built with Vite),
give the page a global `Buffer` first. Vite calls `Buffer.from()` from code that runs after
Lifo has put its own globals back:

```js
import { Buffer } from '@lifo-sh/core';
globalThis.Buffer ??= Buffer;
```

## Several boxes on one page

Each `Sandbox.create()` is a separate box with its own files, processes and ports. Two boxes
running Node programs at the same moment share the page's `console` and `process` globals,
so their output can cross. Keep one box busy at a time, or run each box in its own iframe.

`box.destroy()` marks a box as gone but doesn't stop programs still running in it. Kill them
first:

```js
const procs = box.shell.getProcessRegistry();
for (const p of procs.getRunning()) procs.kill(p.pid);
box.destroy();
```

## Security

A box keeps its programs apart from each other, not from your page. Code running in a box
runs in the page's own JavaScript realm and can reach its DOM, cookies and storage. Don't run
code you don't trust in a box on a page that holds anything sensitive; put the box in a
sandboxed `<iframe>` on a separate origin instead.
