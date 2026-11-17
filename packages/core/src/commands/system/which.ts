import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';

const BUILTINS = new Set([
  'cd', 'pwd', 'echo', 'clear', 'export', 'exit',
  'true', 'false', 'jobs', 'fg', 'bg', 'history',
  'source', '.', 'alias', 'unalias', 'test', '[',
  'read', 'local', 'shift', 'set', 'command', 'type',
  'break', 'continue', 'return',
]);

/**
 * `which <name>`: answers from the box's real command table, so commands registered later
 * (npm, lifo, packages installed with `lifo install`, an embedder's own) are found too.
 */
export function createWhichCommand(registry: CommandRegistry): Command {
  return async (ctx) => {
    if (ctx.args.length === 0) {
      ctx.stderr.write('which: missing operand\n');
      return 1;
    }
    let exitCode = 0;
    for (const name of ctx.args) {
      if (BUILTINS.has(name)) {
        ctx.stdout.write(`${name}: shell built-in command\n`);
      } else if (registry.has(name)) {
        ctx.stdout.write(`/usr/bin/${name}\n`);
      } else {
        ctx.stderr.write(`which: ${name}: not found\n`);
        exitCode = 1;
      }
    }
    return exitCode;
  };
}
