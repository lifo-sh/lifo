# Security and isolation

A Lifo box keeps the programs in it apart from each other: each box has its own files,
processes, ports and environment, and one box can't see another's. A `Sandbox` does **not**
keep those programs apart from the page or the Node.js process that runs the box. That's the
one thing to understand before running code in a box. In a browser,
[`WorkerSandbox`](#a-box-in-a-web-worker) moves the box off the page into a Web Worker.

## What a box isolates

| | Kept separate |
|---|---|
| Files | yes: each box has its own filesystem; it sees host folders only if you mount them |
| Processes and ports | yes: `ps` and `localhost:3000` refer to this box only |
| Environment | yes |
| The host's JavaScript | **no** |

## Why the host isn't protected

There's no emulator: when a program in the box runs JavaScript (`node app.js`, an npm
package's code), that JavaScript runs in the same engine and the same realm as the code that
created the box. Lifo gives it its own `fs`, `process` and `require`, but nothing stops it
from reaching past them to the real globals.

Run this to see it. The code inside the box reads this page's title:

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
const { stdout } = await box.commands.run(
  `node -e "console.log('the page around me is: ' + Function('return document.title')())"`,
);
console.log(stdout);
```

In a browser, that means code in a box can read and change the page's DOM, cookies, storage
and anything the page's JavaScript can reach, and make requests with the user's session. In
Node.js, it can reach the real `process`, the real filesystem and the network, with your
user's permissions.

## A box in a Web Worker

`WorkerSandbox` runs the box in its own Web Worker instead of the page. Code in the box then
runs in the worker's realm: there is no `document`, no page globals and no page storage to
reach, and the worker strips the site's cookies from the requests the box makes. The page
talks to the box over messages, with the same API as `Sandbox` (async where it has to be).

```js
// box.worker.js: the box's realm. Register commands and packages here.
import { serveSandbox } from '@lifo-sh/core';
serveSandbox(self, { setup(box) { /* box.commands.register(...) */ } });
```

```js
// the page
import { WorkerSandbox, pageAuth } from '@lifo-sh/core';
const box = await WorkerSandbox.create({
  worker: new Worker(new URL('./box.worker.js', import.meta.url), { type: 'module' }),
  terminal: document.getElementById('terminal'),
  auth: pageAuth(location.origin), // getToken() runs in the page; only the token crosses
});
await box.commands.run(`node -e "console.log(typeof document)"`); // undefined
```

### On another origin

The strongest setup runs the worker on a different site: a small host page there (the "box
origin") starts the box's worker inside a hidden, sandboxed `<iframe>` and hands the page a port to
it. To the browser the box is then another site, so nothing of the page's site is reachable.

```js
// the page: the box runs on the box origin, previews are served there too
const box = await WorkerSandbox.create({
  host: { origin: 'https://box.example.net' }, // its /box-host page runs serveBoxFrame()
  terminal: document.getElementById('terminal'),
  auth: pageAuth(location.origin),
});
const { base } = await box.servePreviewsOnOrigin(); // <box origin>/_sw/<id>/ + `<port>/`
```

```js
// /box-host on the box origin: answers only the allowed site, starts the worker
import { serveBoxFrame } from '@lifo-sh/core';
serveBoxFrame({
  allowedOrigins: ['https://lifo.sh'],
  createWorker: () => new Worker(new URL('./box.worker.js', import.meta.url), { type: 'module', name: 'lifo-box-port' }),
  serviceWorker: { url: '/sw.js', scope: '/_sw/' }, // previews, on the box origin
});
// box.worker.js: serveSandboxWhenConnected(self, { setup }) serves the box on the port it's handed
```

The box origin must be a different registrable domain, not a subdomain of the site (same-site
cookies would still be sent). The host page should only be frameable by the site
(`Content-Security-Policy: frame-ancestors https://your.site`), and the box origin should serve
nothing but that page, its scripts and the preview service worker. Previews then run on the box
origin too: an app in the box can't run its pages as your site.

### What each setup stops

Measured in Chrome on lifo.sh's dev server, as a logged-in user, from code inside a box:

| Code in the box can... | `Sandbox` (in the page) | `WorkerSandbox`, same origin | `WorkerSandbox` on a box origin |
|---|---|---|---|
| read or change the page's DOM and JavaScript | yes | **no** | **no** |
| read `localStorage`, `sessionStorage`, `document.cookie` | yes | **no** | **no** |
| `fetch`/XHR/EventSource with the site's cookies | yes | **no** (sent without credentials; the session reads as logged out) | **no** (another site: no cookies, and CORS) |
| `import()` or `importScripts` one of the site's URLs (the browser sends cookies) | yes | **no on lifo.sh**: the site refuses non-fetch loads of `/api/**` (below); elsewhere yes | **no** |
| use the site's IndexedDB and Cache Storage | yes | **yes**, they're per origin | **no**: the box sees its own, empty |
| open a WebSocket to the site | yes | **no** (refused) | opens, but without the site's cookies (they are SameSite=Lax) |
| show a preview page that runs as the site | yes | **yes**: previews are served on the site's origin | **no**: previews are on the box origin |
| use a login you lent with `auth` | yes | yes, by asking for it (`lifo whoami`): it's lent | yes |

**The site's side.** Code in a same-origin worker can still make the browser load a URL with
cookies by importing it as a module or a script. lifo.sh refuses those loads for its API:
`/api/**` answers only `fetch()` and navigations (a request whose `Sec-Fetch-Dest` is `script`,
`json`, `worker`, `image` and the like gets 403), and a request from another site that isn't a
navigation has its cookies dropped. Requests without `Sec-Fetch-*` headers (the CLI, the tunnel
server, the cloud) are unaffected. Any site that hosts boxes in a same-origin worker should do
the same for its own endpoints.

**Treat what comes back as untrusted.** In every setup, code in the box can send messages to the
page: the page should handle what the box returns as data, never as code or HTML.

**On lifo.sh**, the live demos and the dashboard Playground run their boxes on a separate box
origin when one is configured (in development, `127.0.0.1` next to `localhost`), and in a
same-origin worker otherwise. The Agent demo and the [agent page](../build/agents.md) still run
theirs in the page, because the agent's model (WebLLM) and Firefox are wired to the box from the
page.

## What to do about it

- **Code you or your users wrote, or an agent wrote for the user who's watching:** fine. This
  is what Lifo is for. The person running it could run the same code anyway.
- **Code you don't trust, in a browser:** use [`WorkerSandbox`](#a-box-in-a-web-worker) so
  it can't read the page. If the page has a logged-in user or storage worth taking, also serve
  the box's worker from a different origin (another domain, not a subdomain of yours), inside a
  sandboxed `<iframe>`, and hand its port to `WorkerSandbox`. The browser's origin isolation then
  covers what a same-origin worker can't.
- **Code you don't trust, on a server:** run the box in a separate process or container with
  only the permissions you'd give that code anyway, or use a VM-based sandbox. Lifo's own
  [cloud boxes](../cloud/boxes.md) do the equivalent: each box gets its own V8 isolate, no
  bindings, and only the public internet.
- **`--mount` and `mounts`** decide which host folder shows up inside the box's filesystem,
  not what a program could reach if it tried.
- **`auth` (a lent login)** isn't hidden from code in the box. `Sandbox.create({ auth })`
  keeps the token out of the box's env and files, but code running in the box shares the page's
  realm and can call `getToken()` or read it from memory, then use it from anywhere until it
  expires. Lend only short-lived tokens, and only to boxes that run code the account holder
  chose to run. On lifo.sh, a logged-in visitor's terminals get a one-hour token. With it, code
  in that terminal could open, list and stop tunnels, push and delete cloud boxes, and read the
  account's email, for up to an hour. It can't change the password, make API keys or use the
  rest of the dashboard. Embeds on other sites never get one.

## Tunnels

`lifo tunnel` puts a port on a public URL, so anyone with the URL can reach the server
behind it. Every tunnel belongs to a logged-in lifo.sh account, and you can see and stop
yours on the dashboard. Don't tunnel a server that has no authentication of its own and
holds anything private.
