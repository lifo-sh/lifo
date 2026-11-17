# Lifo documentation

Lifo is a small Linux-like operating system written in TypeScript. It boots in a few
milliseconds inside a browser tab or a Node.js process: a kernel, a filesystem, a bash-like
shell, processes, ports and a Node.js runtime, with no VM or emulator underneath.

These docs are organized from "run it" to "how it works" to "every option".

## 1. Run Lifo

Where Lifo runs and how to start it in each place.

- [Where Lifo runs](run/README.md): the four ways to use it and how to pick one
- [In the browser](run/browser.md): `@lifo-sh/core` in a web page, headless or with a terminal
- [In Node.js](run/node.md): the same box in a script, a test or a server
- [In your terminal](run/terminal.md): `npx lifo-sh`, an interactive shell on your machine

## 2. Understand it

- [Why Lifo](understand/why.md): what it's for, what it isn't, how it compares
- [Architecture](understand/architecture.md): kernel, filesystem, shell, processes, the Node.js layer, networking
- [One box, in the tab and in the cloud](understand/tab-and-cloud.md): where a box runs, what swaps for a service in the cloud, how Lifo Cloud is put together
- [Security and isolation](understand/security.md): what a box does and doesn't protect
- [Limitations](understand/limitations.md): what doesn't run, and where it differs from Linux and Node.js
- [Performance](understand/performance.md): boot time and size, measured in your browser

## 3. Build with it

- [Files, persistence and snapshots](build/files.md): the filesystem, keeping files, moving a box
- [Servers and previews](build/previews.md): servers in a box, and showing them in your page
- [Packages](build/packages.md): `npm`, `lifo install`, writing a Lifo package
- [Python](build/python.md): `python3` and `pip` in a box (CPython on WebAssembly)
- [An AI agent in the tab](build/agents.md): `agent` (WebLLM on WebGPU) and `browser`, a text web browser
- [Embedding](build/embedding.md): a terminal, file explorer and preview in your app, or the playground
- [Recipes](build/recipes.md): a Vite app, an Expo app, a database, an agent loop

## 4. lifo.sh

- [Accounts and login](cloud/accounts.md): `lifo login`, sites, API keys
- [Tunnels](cloud/tunnels.md): a public URL for a port with `lifo tunnel`
- [Cloud boxes](cloud/boxes.md): move a box to Lifo Cloud and keep it running (preview)
- [Services](cloud/services.md): tools that run on Lifo's servers, like native `ffmpeg` (preview)

## 5. Reference

- [Sandbox API](reference/sandbox.md): `@lifo-sh/core`
- [UI components](reference/ui.md): `@lifo-sh/ui`
- [The lifo-sh CLI](reference/cli.md)
- [The lifo command](reference/lifo-command.md): inside a box
- [Shell and commands](reference/shell.md)
- [Environment variables](reference/environment.md)

## 6. For agents

- [Lifo for coding agents](agents/README.md): the agent skill, the docs as Markdown, prompts to copy
