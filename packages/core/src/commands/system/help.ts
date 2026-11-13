import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';

// Builtins live in the shell, not the registry, so they're listed here.
const BUILTINS = [
  'cd', 'pwd', 'echo', 'read', 'export', 'local', 'set', 'shift', 'alias', 'unalias',
  'source', '.', 'test', '[', 'command', 'type', 'true', 'false', 'return', 'break',
  'continue', 'exit', 'clear', 'jobs', 'fg', 'bg', 'history',
];

// How registered commands are grouped. Only commands that are actually registered are shown,
// and anything registered that isn't listed here (packages such as git, vi or ffmpeg, or an
// embedder's own commands) appears under "Other commands".
const CATEGORIES: Record<string, string[]> = {
  'File system': [
    'ls', 'cat', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'find', 'tree',
    'stat', 'ln', 'du', 'df', 'chmod', 'file', 'rmdir', 'realpath',
    'basename', 'dirname', 'mktemp', 'chown',
  ],
  'Text processing': [
    'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
    'sed', 'awk', 'diff', 'nl', 'rev', 'base64', 'sha256sum',
  ],
  'I/O utilities': ['tee', 'xargs', 'yes', 'printf'],
  'System': [
    'env', 'uname', 'date', 'sleep', 'uptime', 'whoami', 'hostname',
    'free', 'which', 'ps', 'top', 'kill', 'watch', 'help', 'systemctl',
  ],
  'Network': ['curl', 'wget', 'ping', 'dig', 'host', 'ifconfig', 'ip', 'netstat', 'ports'],
  'Archive': ['tar', 'gzip', 'gunzip', 'zip', 'unzip'],
  'Node.js': ['node', 'npm', 'npx', 'lifo'],
};

function writeColumns(out: { write(t: string): void }, names: string[]): void {
  const width = Math.max(12, ...names.map((n) => n.length + 2));
  const cols = Math.max(1, Math.floor(76 / width));
  for (let i = 0; i < names.length; i += cols) {
    out.write(`  ${names.slice(i, i + cols).map((c) => c.padEnd(width)).join('').trimEnd()}\n`);
  }
  out.write('\n');
}

export function createHelpCommand(registry: CommandRegistry): Command {
  return async (ctx) => {
    const registered = new Set(registry.list());
    ctx.stdout.write('Lifo Commands\n');
    ctx.stdout.write('==================\n\n');

    ctx.stdout.write('Shell builtins:\n');
    writeColumns(ctx.stdout, BUILTINS);

    const shown = new Set<string>();
    for (const [category, commands] of Object.entries(CATEGORIES)) {
      const present = commands.filter((c) => registered.has(c));
      present.forEach((c) => shown.add(c));
      if (present.length === 0) continue;
      ctx.stdout.write(`${category}:\n`);
      writeColumns(ctx.stdout, present);
    }

    const other = [...registered].filter((c) => !shown.has(c) && !BUILTINS.includes(c)).sort();
    if (other.length > 0) {
      ctx.stdout.write('Other commands:\n');
      writeColumns(ctx.stdout, other);
    }

    ctx.stdout.write(
      registered.has('man')
        ? 'Use "man <command>" for detailed help on a specific command.\n'
        : 'Most commands take --help. Install more with "lifo install <package>".\n',
    );
    return 0;
  };
}
