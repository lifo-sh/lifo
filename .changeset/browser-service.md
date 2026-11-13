---
'@lifo-sh/core': minor
'lifo-pkg-agent': minor
'lifo-sh': minor
---

A real Chromium for every box, on Lifo's Browser service.

- `lifo-pkg-agent/chromium`: `createChromiumBrowserCommand()` and `ChromiumFrame`. `browser` drives a real headless Chromium over CDP with the same verbs as the text browser and Firefox: from `BROWSER_WS_ENDPOINT` (any CDP endpoint; cloud boxes get their own), or a session from Lifo's Browser service with the box's login, attached on first use. `LIFO_BROWSER=local|remote|auto` chooses; outside a tab `auto` uses the service.
- `lifo-sh`: `browser` in every box, on the Browser service with your login.
- core: WebSocket clients in a box. `http.request` / `https.request` with `Upgrade: websocket` (the `ws` package, so playwright-core's `connectOverCDP`, puppeteer, socket.io-client) now work: to a server in the same box, bytes pass straight through; anywhere else, the host's own WebSocket carries the frames. `localhost` is the box only, never the host's loopback.
- core: `fs.mkdtemp`, `fs.mkdtempSync` and `fs.promises.mkdtemp`.
- core: `LifoServices.browserSession(box)`, `browserState(box)` and `closeBrowser(box)`, and `connectServices(ctx, what)` for other packages' commands.
- core: the socket stand-in for in-box WebSocket servers calls write callbacks asynchronously, as Node does (a synchronous callback let `ws` hold a node run open for 30 s after a close).
