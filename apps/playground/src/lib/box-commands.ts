// The commands every playground box has beyond core's own: git, the editors and pagers (nano,
// vi/vim, less), cal, bc, man, fastfetch and Python, plus ffmpeg or orchd when an example asks
// for them. Page shells (bootShell), boxes made with Sandbox.create and boxes in a
// Web Worker (box.worker.ts) all register them from here, so a command that works in one
// terminal works in every terminal of every example. Nothing here may touch the DOM: the worker
// imports it too.
import type { Command } from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';
import fastfetchCommand from 'lifo-pkg-fastfetch';
import nanoCommand from 'lifo-pkg-nano';
import lessCommand from 'lifo-pkg-less';
import viCommand from 'lifo-pkg-vi';
import calCommand from 'lifo-pkg-cal';
import bcCommand from 'lifo-pkg-bc';
import manCommand from 'lifo-pkg-man';

/** A command loaded the first time it runs, so a large package costs nothing until then. */
const lazy = (load: () => Promise<Command>): Command => async (ctx) => (await load())(ctx);

export function registerBoxCommands(register: (name: string, command: Command) => void, pkgs: readonly string[] = []): void {
  register('git', gitCommand);
  register('fastfetch', fastfetchCommand);
  register('neofetch', fastfetchCommand);
  register('nano', nanoCommand);
  register('less', lessCommand);
  register('vi', viCommand);
  register('vim', viCommand);
  register('cal', calCommand);
  register('bc', bcCommand);
  register('man', manCommand);
  // Python (Pyodide): the package is a few KB and the interpreter (about 6 MB) comes from the
  // CDN only when someone types `python3`.
  for (const name of ['python', 'python3']) register(name, lazy(async () => (await import('lifo-pkg-python')).default));
  for (const name of ['pip', 'pip3']) register(name, lazy(async () => (await import('lifo-pkg-python')).pip));
  if (pkgs.includes('ffmpeg')) register('ffmpeg', lazy(async () => (await import('lifo-pkg-ffmpeg')).default));
  if (pkgs.includes('orchd')) register('orchd', lazy(async () => (await import('orchd/lifo')).default));
}
