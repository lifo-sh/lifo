# Limitations

Lifo reimplements a Unix system and Node.js in TypeScript. That's what makes it small and
fast, and it's also where its limits come from.

## What doesn't run

- **Linux binaries.** No `apt`, `gcc`, `go`, `docker` or prebuilt executables. Tools come as
  JavaScript or WebAssembly (`lifo install ffmpeg`, `esbuild-wasm`).
- **Python, with limits.** `python3` is CPython on WebAssembly (Pyodide): the standard library,
  pure-Python packages from PyPI and the packages Pyodide builds (numpy, pandas, …). No
  native extensions beyond those, no subprocesses or threads, and the first run downloads
  about 6 MB. See [Python](../build/python.md).
- **Native npm addons.** Packages with a compiled `.node` file don't load, unless Lifo ships a
  WebAssembly stand-in for them (it does for esbuild, SWC, Rollup's parser and Tailwind's
  oxide).
- **Raw sockets.** Programs make HTTP(S) and WebSocket requests through the host's `fetch`
  and `WebSocket`; there's no raw TCP or UDP to the outside world. Inside the box, `net`
  and `http` servers work.

## Where it differs from Linux and Node.js

- **The shell is bash-like, not bash.** Everyday syntax works, including brace expansion,
  subshells, here-documents and `read`; arrays, `[[ ]]`, `(( ))`, `trap` and word splitting of
  unquoted variables don't yet. See [Shell and commands](../reference/shell.md).
- **Node.js is a compatibility layer.** The common modules are there and real tools (Vite,
  Express, Metro, npm itself) run, but some APIs and edge cases are missing or approximate.
  Report what breaks.
- **Processes share one thread.** Programs run concurrently while they wait for I/O, but a
  program that computes for a long time without awaiting blocks the others, and in a
  browser it blocks the page too.
- **Programs in different boxes share some globals.** Two boxes running Node programs at the
  same moment share the page's `console` and `process`, so output can cross between them.
- **Memory is the host's.** Files live in memory (and in IndexedDB with `persist: true`); a
  large `node_modules` costs the tab that much RAM.

## In the browser

- **Network requests follow the browser's rules.** Hosts that don't send CORS headers can't
  be reached directly; the npm registry and common CDNs are fine.
- **Previews need a service worker** served from your origin, or the no-service-worker mode
  with its own limits.
- **No real ports on the user's machine.** A server in the box is reachable from the page, an
  iframe preview or a tunnel, not from other apps on the computer.

## Known issues

These are tracked and will be fixed:

- `box.destroy()` doesn't stop running programs; kill them first.
- Some text commands treat extensionless files (like `/proc/cpuinfo`) as binary.
