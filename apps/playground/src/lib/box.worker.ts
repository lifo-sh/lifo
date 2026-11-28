/// <reference lib="webworker" />
// A Lifo box in its own Web Worker (the Isolation example, and project examples with `worker`).
// The page talks to it through WorkerSandbox; code in the box can't reach the page's DOM,
// storage or cookies. A box here can also run tools that need WebAssembly threads, which a
// page's main thread refuses (Vite 8's Rolldown).
import { serveSandbox, type RpcEndpoint } from '@lifo-sh/core';
import { registerBoxCommands } from './box-commands';

serveSandbox(self as unknown as RpcEndpoint, {
  // The same commands as every page shell (git, nano, vi, less, python, ...), plus the
  // packages the page asked for with `setup: { pkgs }`.
  setup(box, extra) {
    const pkgs = (extra as { pkgs?: string[] } | undefined)?.pkgs ?? [];
    registerBoxCommands((name, command) => box.commands.register(name, command), pkgs);
  },
});
