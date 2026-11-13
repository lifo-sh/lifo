# Lifo

Lifo is a small Linux-like operating system written in TypeScript. It boots in a few
milliseconds inside a browser tab or a Node.js process: a filesystem, a bash-like shell,
processes, ports and a Node.js runtime, with no VM or emulator underneath. `npm install`,
Vite, Express and Expo run in it, and so does `python3` (CPython on WebAssembly).

**Docs: [lifo.sh/docs](https://lifo.sh/docs)** (source in [docs/](docs/README.md)) ·
**Try it: [lifo.sh/playground](https://lifo.sh/playground)**

## In the browser

```bash
npm install @lifo-sh/core
npm install @lifo-sh/ui @xterm/xterm   # only for a terminal on the page
```

```js
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.fs.writeFile('/home/user/hello.js', 'console.log("hi from", process.platform)');
const { stdout } = await box.commands.run('node hello.js');

// Or give people a terminal: the same box, typed into.
await box.attach('#terminal');
```

## In Node.js

```js
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create({ mounts: [{ virtualPath: '/work', hostPath: process.cwd() }] });
const r = await box.commands.run('cd /work && ls | wc -l');
console.log(r.stdout, r.exitCode);
```

## In your terminal

```bash
npx lifo-sh                  # an interactive Lifo shell on your machine
npx lifo-sh login            # log in to lifo.sh in the browser
npx lifo-sh tunnel 3000      # a public URL for a port: https://<name>-tunnel.lifo.sh
```

Inside a box, the `lifo` command does the same: `lifo install git`, `lifo login`,
`lifo tunnel 5173`.

## Where to read next

- [Where Lifo runs](docs/run/README.md): browser, Node.js, terminal, and which to pick
- [Why Lifo](docs/understand/why.md), [Architecture](docs/understand/architecture.md),
  [Security and isolation](docs/understand/security.md), [Limitations](docs/understand/limitations.md)
- [Servers and previews](docs/build/previews.md), [Packages](docs/build/packages.md),
  [Embedding](docs/build/embedding.md), [Recipes](docs/build/recipes.md)
- Reference: [Sandbox API](docs/reference/sandbox.md), [Shell and commands](docs/reference/shell.md),
  [the CLI](docs/reference/cli.md)
- For coding agents: [the Lifo skill](skills/lifo/SKILL.md)

## Working on Lifo

```bash
pnpm install
pnpm dev          # the playground at http://localhost:5173
pnpm test         # all packages
pnpm build
```

| Path | What it is |
|---|---|
| `packages/core` | `@lifo-sh/core`: kernel, filesystem, shell, commands, Node.js layer, `Sandbox` |
| `packages/ui` | `@lifo-sh/ui`: terminal, file explorer, preview browser |
| `packages/cli` | `lifo-sh`: the terminal CLI |
| `packages/lifo-pkg-*` | installable commands (git, vi, nano, less, ffmpeg, ...) |
| `apps/playground` | the examples at lifo.sh/playground |
| `apps/desktop` | the desktop demo |
| `docs/`, `skills/` | these docs and the agent skill |

Releases: [RELEASING.md](RELEASING.md).

## Related projects

Lifo is built by the team behind **[RapidNative](https://rapidnative.com)** — AI that
generates production-ready React Native apps and UIs from a prompt — alongside these
open-source tools:

| Project | What it is |
| --- | --- |
| [RapidNative](https://rapidnative.com) | AI that generates production-ready React Native apps and UIs from a prompt |
| [tinbase](https://tinbase.dev) | A Supabase-compatible backend without Docker — one process, real Postgres, runs in the browser |
| [ORCHD](https://rapidnative.github.io/orchd) | A multi-tenant workload orchestrator — per-tenant workloads that sleep when idle and wake on the next request |
| [jetplane](https://sanketsahu.github.io/jetplane) | A Metro plugin and a thin dev server for Expo — many dev environments per machine |

See them all on [rapidnative.com/open-source](https://www.rapidnative.com/open-source).

## License

MIT
