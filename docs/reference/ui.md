# UI components (@lifo-sh/ui)

```bash
npm install @lifo-sh/ui @xterm/xterm
```

```js
import '@xterm/xterm/css/xterm.css';   // the terminal's styles; @lifo-sh/ui doesn't load them
```

Browser only. Each component takes a container element and fills it.

## Terminal

An xterm.js terminal that implements `ITerminal`, so a box's shell can use it.

```js
import { Terminal } from '@lifo-sh/ui';

const terminal = new Terminal(element, { fontSize: 13, webgl: false, theme: { background: '#07081a' } });
const box = await Sandbox.create({ terminal });
```

| Option | |
|---|---|
| `fontSize` | pixels |
| `webgl` | the WebGL renderer (default on; falls back to the DOM renderer). Turn it off to save a WebGL context. |
| `theme` | an xterm.js `ITheme`; the default is Tokyo Night |

Methods: `write(text)`, `writeln(text)`, `onData(callback)`, `focus()`, `clear()`,
`refit()` (after the container changes size; resizes are also tracked automatically),
`setFontSize(px)`, `setTheme(theme)`, `setWebgl(on)`. Properties: `cols`, `rows`.

## FileExplorer

A file tree with an editor, working on a box's filesystem.

```js
import { FileExplorer } from '@lifo-sh/ui';

const explorer = new FileExplorer(element, box.kernel.vfs, { cwd: '/home/user/app' });
const off = explorer.on((event) => { /* open, select, navigate, create, delete */ });
```

| Option | |
|---|---|
| `cwd` | the folder to show first |
| `showHidden` | show dotfiles |
| `editorProvider` | `{ create(container, content, language) → { getValue(), onDidChangeContent(cb), dispose() } }`, for Monaco or CodeMirror; default is a text area |
| `openWithApps(path)`, `onOpenWith(path, appId)` | an "Open with" menu |

Methods: `navigateTo(path)`, `refresh()`, `on(handler) → unsubscribe`.

## PreviewBrowser

An iframe with browser chrome (back, forward, reload, address bar, open in new tab), showing a
server in a box. See [Servers and previews](../build/previews.md).

```js
import { PreviewBrowser } from '@lifo-sh/ui';

const preview = new PreviewBrowser(element, { port: 5173, bridge });
```

| Option | |
|---|---|
| `port` | the box port to show |
| `bridge` | the box's connected `ServiceWorkerBridge` (default transport) |
| `transport` | `'sw'` (default) or `'postmessage'` (no service worker; pass `kernel`) |
| `kernel` | `box.kernel`, for `'postmessage'` |
| `path` | the first path to open (default `/`) |
| `chrome` | show the toolbar (default `true`) |

Methods: `navigate(path)`, `back()`, `forward()`, `reload()`, `setPort(port)`, `route()`
(the current path), `destroy()`.

## mountNoSwPreview

```js
import { mountNoSwPreview } from '@lifo-sh/ui';
const handle = await mountNoSwPreview(iframe, box.kernel, 5173, '/');
handle.destroy();
```

A preview without a service worker: the page is loaded into a blob iframe and its requests
are bridged with `postMessage`. For dev-server pages; some apps need the service worker.
