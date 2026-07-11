# @lifo-sh/ui

Embeddable UI components for [Lifo](https://github.com/lifo-sh/lifo) — a tiny Linux-like VM that runs in the browser. Framework-agnostic: mount them into any DOM element.

- **`Terminal`** — a themeable xterm.js terminal (WebGL, auto-fit) bound to a box's shell.
- **`PreviewBrowser`** — an iframe view bound to an in-VM port, with optional Chrome-like chrome (back / forward / reload, a friendly address bar, open-in-new-tab).
- **`FileExplorer`** — a file tree over the box's filesystem (optional editor).

## Install

```bash
npm install @lifo-sh/ui @lifo-sh/core
```

## Usage

A terminal, bound to a box's shell:

```typescript
import { Terminal } from '@lifo-sh/ui';
import { Sandbox } from '@lifo-sh/core';

const terminal = new Terminal(document.getElementById('terminal'));
const sandbox = await Sandbox.create({ terminal });
```

A live preview of an in-VM port:

```typescript
import { ServiceWorkerBridge } from '@lifo-sh/core';
import { PreviewBrowser } from '@lifo-sh/ui';

const bridge = new ServiceWorkerBridge(sandbox.kernel.portRegistry);
await bridge.connect('/sw.js', '/');
new PreviewBrowser(document.getElementById('preview'), { bridge, port: 3000 });
```

See the [Embeddable UI docs](https://lifo.sh/docs/embeddable-ui) for a complete from-scratch example (box + terminal + preview) and the full API.

## What's included

- `Terminal` — xterm.js + WebGL + auto-fit, implements `ITerminal` from `@lifo-sh/core`.
- `PreviewBrowser` — service-worker-backed iframe preview of an in-VM port.
- `FileExplorer` — filesystem tree with an optional editor provider.
- Themed with CSS variables (`--tk-*`, Tokyo Night by default) — override to reskin.

## Packages

| Package | Description |
|---|---|
| [@lifo-sh/core](https://www.npmjs.com/package/@lifo-sh/core) | Kernel, shell, commands, sandbox API |
| **@lifo-sh/ui** | Embeddable UI — terminal, preview browser, file explorer |
| [lifo-sh](https://www.npmjs.com/package/lifo-sh) | CLI — run Lifo in your terminal |

## Links

- [GitHub](https://github.com/lifo-sh/lifo)
- [Issues](https://github.com/lifo-sh/lifo/issues)

## License

MIT
