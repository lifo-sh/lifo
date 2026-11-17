# lifo-sh

CLI for [Lifo](https://github.com/lifo-sh/lifo) -- a Linux-like OS that runs natively in JavaScript. Run Lifo directly in your terminal.

## Quick Start

```bash
npx lifo-sh
```

## Install

```bash
npm install -g lifo-sh
lifo
```

## What You Get

A full shell environment with 60+ commands, powered by `@lifo-sh/core`:

- Bash-like shell with pipes, redirects, globs, variables, tab completion, history
- Virtual filesystem with standard Unix hierarchy
- Commands: `ls`, `grep`, `awk`, `sed`, `curl`, `find`, `tar`, `node`, and more
- Node.js compatibility layer for running JS scripts

```
 _     _  __
| |   (_)/ _| ___
| |   | | |_ / _ \
| |___| |  _| (_) |
|_____|_|_|  \___/

user@lifo:~$ ls
examples
user@lifo:~$ echo hello | tr a-z A-Z
HELLO
user@lifo:~$ node -e "console.log(2 + 2)"
4
```

## Your account: login, tunnels and the cloud

```bash
lifo-sh login                       # approve in the browser; saved to ~/.lifo/auth.json
lifo-sh tunnel 3000 --name my-app   # localhost:3000 at https://my-app-tunnel.lifo.sh
lifo-sh cloud push my-api --port 3000 --start "node server.js"   # keep this folder running
lifo-sh cloud ls | exec | logs | save | pull | restart | rm
```

`cloud push` puts the current folder into a box at `/home/user/app` (without `.git`) and uploads
it to Lifo Cloud, which is in preview. See [Tunnels](https://lifo.sh/docs/cloud/tunnels) and
[Cloud boxes](https://lifo.sh/docs/cloud/boxes). Add `--local` to `login` to use a website
running on localhost:3000.

## Packages

| Package | Description |
|---|---|
| [@lifo-sh/core](https://www.npmjs.com/package/@lifo-sh/core) | Kernel, shell, commands, sandbox API |
| [@lifo-sh/ui](https://www.npmjs.com/package/@lifo-sh/ui) | Terminal UI (xterm.js wrapper) |
| **lifo-sh** | CLI -- run Lifo in your terminal |

## Links

- [GitHub](https://github.com/lifo-sh/lifo)
- [Issues](https://github.com/lifo-sh/lifo/issues)

## License

MIT
