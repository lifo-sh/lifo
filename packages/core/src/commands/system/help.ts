import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';

const BUILTINS = [
  'cd', 'pwd', 'echo', 'clear', 'export', 'exit',
  'true', 'false', 'jobs', 'fg', 'bg', 'history',
  'source', '.', 'alias', 'unalias',
];

const CATEGORIES: Record<string, string[]> = {
  'Shell builtins': BUILTINS,
  'File system': [
    'ls', 'cat', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'find', 'tree',
    'stat', 'ln', 'du', 'df', 'chmod', 'file', 'rmdir', 'realpath',
    'basename', 'dirname', 'mktemp', 'chown',
  ],
  'Text processing': [
    'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
    'sed', 'awk', 'diff', 'nl', 'rev',
  ],
  'I/O utilities': ['tee', 'xargs', 'yes', 'printf'],
  'System': [
    'env', 'uname', 'date', 'sleep', 'uptime', 'whoami', 'hostname',
    'free', 'which', 'ps', 'top', 'kill', 'watch', 'cal', 'bc',
    'man', 'help', 'systemctl',
  ],
  'Network': ['curl', 'wget', 'ping', 'dig'],
  'Archive': ['tar', 'gzip', 'gunzip', 'zip', 'unzip'],
  'Node.js': ['node', 'npm', 'lifo'],
};

export function createHelpCommand(_registry: CommandRegistry): Command {
  return async (ctx) => {
    ctx.stdout.write('Lifo Commands\n');
    ctx.stdout.write('==================\n\n');

    for (const [category, commands] of Object.entries(CATEGORIES)) {
      ctx.stdout.write(`${category}:\n`);
      // Format in columns
      const cols = 6;
      for (let i = 0; i < commands.length; i += cols) {
        const row = commands.slice(i, i + cols)
          .map(c => c.padEnd(12))
          .join('');
        ctx.stdout.write(`  ${row}\n`);
      }
      ctx.stdout.write('\n');
    }

    ctx.stdout.write('Use "man <command>" for detailed help on a specific command.\n');
    return 0;
  };
}
