# Servers and previews

A server in a box listens on the box's own network. `node server.js`, `npm run dev`,
`vite`, `next dev`, Express, a Postgres-compatible database: each binds a port in the box's
port table, and anything in the box can reach it at `localhost:<port>`.

Getting to that server from outside the box is a choice of door:

| From | Use | Works in |
|---|---|---|
| your code | `box.fetch(url)`, `box.connect(port, path)` | browser, Node |
| a person, in an `<iframe>` on your page | a **preview**: a service worker answers the iframe from the box | browser |
| your machine's browser and tools | `lifo-sh --expose <port>` | CLI |
| anyone, on the internet | `lifo tunnel <port>` | everywhere ([Tunnels](../cloud/tunnels.md)) |

## From your code

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.fs.writeFile('/home/user/api.js', `
  const http = require('http');
  http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  }).listen(8080);
`);
await box.commands.run('node api.js &');
await box.waitForPort(8080);

const res = await box.fetch('http://localhost:8080/users?limit=2', { method: 'POST', body: 'hi' });
console.log(res.status, await res.json());
```

`box.fetch` returns a standard `Response`. An unbound port answers 404 with an `x-lifo:
no-server` header instead of throwing; a server that doesn't answer in time gets a 504.
`box.waitForPort(port)` resolves once something listens, which isn't always the same as
ready, so retry the first request if your server needs a moment.

`box.connect(port, path)` opens a WebSocket to a server in the box (for example Vite's hot
reload channel) and resolves once the handshake is done.

## Previews: showing a server in an iframe

An `<iframe>` makes ordinary HTTP requests, so something has to answer them from the box. Lifo
uses a service worker: the page registers it, the worker catches requests to
`/_sw/<boxId>/<port>/...`, and forwards them to the box over a `MessageChannel`. The app inside
the iframe doesn't know: its own requests for `/src/main.jsx` or `/@vite/client`, and its
WebSocket for hot reload, are routed back to the same box.

**1. Serve the worker from your origin.** The worker ships in the npm package as
`@lifo-sh/core/sw.js` ([source](../../packages/core/sw.js)). Copy it into your static files,
for example as `/lifo-sw.js`, and copy it again when you upgrade `@lifo-sh/core` so the two
stay in step:

```bash
cp node_modules/@lifo-sh/core/sw.js public/lifo-sw.js
```

A `postinstall` script (`"postinstall": "cp node_modules/@lifo-sh/core/sw.js public/lifo-sw.js"`)
keeps it current. With a bundler you can also import its URL, for example in Vite:
`import swUrl from '@lifo-sh/core/sw.js?url'`. A worker can only control paths at or below
its own location, so either serve it from the root, or keep it in a folder and send
`Service-Worker-Allowed: /_sw/` with it.

**2. Connect the box.**

```js
import { Sandbox, ServiceWorkerBridge } from '@lifo-sh/core';

const box = await Sandbox.create();
const bridge = new ServiceWorkerBridge(box.kernel.portRegistry);
await bridge.connect('/lifo-sw.js', '/_sw/');   // worker URL, scope
```

**3. Start a server and point an iframe at it.**

```js
await box.commands.run('cd ~/app && npm run dev &');
await box.waitForPort(5173);
iframe.src = `/_sw/${bridge.boxId}/5173/`;
```

Each box gets its own `boxId`, so several boxes can preview at once, even on the same port.
The worker only controls `/_sw/`, never the rest of your site. Service workers need HTTPS
(or `localhost`).

### With the preview browser

`PreviewBrowser` from `@lifo-sh/ui` wraps the iframe in browser chrome (back, forward,
reload, an address bar and open-in-new-tab):

```js
import { PreviewBrowser } from '@lifo-sh/ui';

const preview = new PreviewBrowser(document.getElementById('preview'), { port: 5173, bridge });
preview.navigate('/about');
```

### Without a service worker

Where service workers aren't available (some embedded webviews, cross-origin iframes),
`mountNoSwPreview(iframe, box.kernel, port, path)` from `@lifo-sh/ui` renders the server's page
into a blob iframe and bridges its requests with `postMessage`. It handles typical dev-server
pages; apps that depend on exact URLs or service workers of their own may not work. Or pass
`transport: 'postmessage'` and `kernel` to `PreviewBrowser`.

## Hot reload

Vite's and Metro's hot reload work in previews: their WebSockets go through the same worker
to the box. Edit a file with `box.fs.writeFile` and the preview updates.

## Try it

[Vite with React](https://lifo.sh/playground/index.html?example=vite-react)
