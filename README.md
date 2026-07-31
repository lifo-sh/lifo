# Lifo

A tiny Linux-like operating system, written in TypeScript, that runs anywhere JavaScript does -- a browser tab, a Node.js process, a serverless function. Not a VM, not an emulator -- a clean-room reimplementation of Unix in TypeScript, where the JS runtime is the kernel and its APIs are the system calls.

```
┌──────────────────────────────────────────────────┐
│                  Terminal UI                      │  xterm.js + Tokyo Night theme
├──────────────────────────────────────────────────┤
│                    Shell                          │  bash-like interpreter
├──────────────────────────────────────────────────┤
│            Command Registry / $PATH              │  ES module command map
├───────────┬────────────┬─────────────────────────┤
│ Coreutils │ Net Cmds   │ User Packages           │  each cmd = async function
├───────────┴────────────┴─────────────────────────┤
│          Node.js Compatibility Layer             │  thin wrappers over OS APIs
├──────────────────────────────────────────────────┤
│           Virtual Filesystem (VFS)               │  in-memory + IndexedDB persistence
├──────────────────────────────────────────────────┤
│              Kernel API Layer                    │  unified browser API wrappers
├──────────────────────────────────────────────────┤
│               Browser APIs                       │  fetch, streams, OPFS, etc.
└──────────────────────────────────────────────────┘
```

## Getting Started

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173 in a modern browser. You'll be greeted with a fully functional terminal.

```bash
pnpm build        # Production build
pnpm test         # Run test suite
pnpm typecheck    # Type check without emitting
```

## What's Inside

### Kernel

- **Virtual Filesystem (VFS)** -- synchronous in-memory INode tree with full POSIX-like semantics (read, write, stat, mkdir, symlinks, hard links, permissions)
- **Virtual Providers** -- `/proc` exposes system info (uptime, meminfo, cpuinfo, version) and `/dev` provides device files (null, zero, random, urandom)
- **Persistence** -- IndexedDB-backed filesystem persistence with serialization/deserialization of the entire INode tree

### Shell

A bash-like shell with:

- Full **lexer/parser/interpreter** pipeline producing an AST
- **Pipes** (`ls | grep foo | wc -l`), **redirects** (`>`, `>>`, `<`, `2>`, `&>`)
- **Logical operators** (`&&`, `||`), **sequences** (`;`), **background** (`&`)
- **Variable expansion** (`$VAR`, `${VAR:-default}`), **command substitution** (`$(...)`)
- **Glob expansion** (`*.txt`, `**/*.js`), **tilde expansion** (`~`), **brace expansion** (`{a,b,c}`)
- **Tab completion** for commands, files, and directories
- **Command history** with reverse search
- **Job control** (Ctrl+C, `fg`, `bg`, `jobs`)
- **Builtins**: `cd`, `pwd`, `export`, `alias`, `source`, `read`, `test`, `echo`, and more

### 60+ Commands

| Category | Commands |
|---|---|
| **Filesystem** | `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`, `ln`, `stat`, `find`, `tree`, `du`, `df`, `chmod`, `file`, `basename`, `dirname`, `realpath`, `mktemp` |
| **Text** | `grep`, `sed`, `awk`, `head`, `tail`, `sort`, `uniq`, `wc`, `cut`, `tr`, `diff`, `nl`, `rev` |
| **I/O** | `printf`, `tee`, `xargs`, `yes` |
| **Network** | `curl`, `wget`, `ping`, `dig` |
| **System** | `ps`, `top`, `kill`, `env`, `uname`, `whoami`, `hostname`, `uptime`, `free`, `date`, `cal`, `bc`, `sleep`, `watch`, `which`, `man`, `help` |
| **Archive** | `tar`, `gzip`, `gunzip`, `zip`, `unzip` |
| **Runtime** | `node` (run JS with Node.js compat layer), `pkg` (package manager) |

### Node.js Compatibility Layer

Run JavaScript files with `node script.js` or `node -e "code"`. The compatibility layer maps 15 Node.js standard library modules to browser APIs:

`fs`, `path`, `events`, `buffer`, `util`, `os`, `process`, `http`, `child_process`, `stream`, `url`, `timers`, `crypto`, `console`

### Package Manager

```bash
pkg install <url>    # Install a package from URL
pkg remove <name>    # Uninstall a package
pkg list             # List installed packages
pkg info <name>      # Show package details
```

## Filesystem Hierarchy

```
/
├── home/user/          # User home directory ($HOME)
├── tmp/                # Temporary files (in-memory)
├── etc/                # System configuration
├── var/log/            # System logs
├── usr/bin/            # Installed package binaries
├── proc/               # Virtual: system info (cpuinfo, meminfo, uptime)
├── dev/                # Virtual: devices (null, zero, random, urandom)
└── bin/                # Core commands
```

## Tech Stack

- **TypeScript** (strict mode, ESM throughout)
- **Vite** for builds
- **xterm.js** + WebGL addon for terminal rendering
- **Vitest** for testing
- **Target**: Chrome 110+, Firefox 110+, Safari 16.4+

## Project Structure

```
src/
├── main.ts              # Boot sequence
├── kernel/              # VFS, persistence, virtual providers
├── shell/               # Lexer, parser, interpreter, expander, completer
├── commands/            # All 60+ commands organized by category
├── node-compat/         # Node.js standard library shims
├── pkg/                 # Package manager
├── terminal/            # xterm.js wrapper
└── utils/               # Path, args, glob, colors, encoding, archive
tests/                   # Mirrors src/ structure with full coverage
```

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
