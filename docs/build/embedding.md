# Embedding Lifo in your app

Lifo is a set of pieces you put together: a box, a terminal, a file explorer and a preview.
Use as many as your app needs.

| Piece | From | What it is |
|---|---|---|
| `Sandbox` | `@lifo-sh/core` | the box: files, shell, processes, ports |
| `Terminal` | `@lifo-sh/ui` | an xterm.js terminal wired to the box's shell |
| `FileExplorer` | `@lifo-sh/ui` | a file tree with a built-in editor (or your own, e.g. Monaco) |
| `PreviewBrowser` | `@lifo-sh/ui` | an iframe with browser chrome, showing a server in the box |
| `ServiceWorkerBridge` | `@lifo-sh/core` | the connection that previews run through |

## A small IDE

A file tree on the left, a terminal below, a preview on the right:

```js
import { Sandbox, ServiceWorkerBridge } from '@lifo-sh/core';
import { FileExplorer, PreviewBrowser } from '@lifo-sh/ui';
import '@xterm/xterm/css/xterm.css';

const box = await Sandbox.create({ terminal: '#terminal', cwd: '/home/user/app', files: myProject });

const explorer = new FileExplorer(document.getElementById('files'), box.kernel.vfs, { cwd: '/home/user/app' });
explorer.on((event) => console.log(event));    // open, select, navigate, create, delete

const bridge = new ServiceWorkerBridge(box.kernel.portRegistry);
await bridge.connect('/lifo-sw.js', '/_sw/');   // see Servers and previews
await box.commands.run('npm install && npm run dev &');
await box.waitForPort(5173);
new PreviewBrowser(document.getElementById('preview'), { port: 5173, bridge });
```

`FileExplorer` edits files in a plain text area by default; pass `editorProvider` to use
Monaco or CodeMirror instead. It reads and writes the box's filesystem directly, so the
terminal, the dev server and the explorer always agree.

[Try the file explorer](https://lifo.sh/playground/index.html?example=explorer)

## Or embed the playground

The Lifo playground is the same pieces, already put together, with examples for Node.js, npm,
Vite, Express, Postgres, Supabase, Expo and more. Embed it in an `<iframe>`:

```html
<iframe
  src="https://lifo.sh/playground/index.html?example=vite-react&embed=1"
  style="width: 100%; height: 600px; border: 0"
  allow="clipboard-read; clipboard-write"
></iframe>
```

- `example=<id>` opens one example. Ids: `interactive`, `headless`, `http`, `explorer`, `npm`,
  `vite-react`, `vite-react-ts`, `create-vite`, `express`, `pglite`, `tinbase`, `news`, `expo`,
  `expo-router`, `create-expo-app`, `browser-metro`, `expo-supabase`, `git`, `ffmpeg`.
- `embed=1` hides the examples sidebar.

The playground lives on lifo.sh's origin, so the box runs there, not in your page. That also
keeps code in it away from your page's cookies and storage (see
[Security and isolation](../understand/security.md)).

## Driving a box from your UI

Run commands on the side, and their output comes back to your code (the terminal doesn't
show it):

```js
const { stdout } = await box.commands.run('git status --short');
```

To show commands your app runs in the terminal, as if someone typed them (a guided tutorial,
an agent's actions), pass your own `ITerminal` to `Sandbox.create`. The shell reads input from
the callbacks registered with `onData`, so your terminal can forward the user's keystrokes to
them and inject its own the same way. lifo.sh's landing page does this to type its demos.
