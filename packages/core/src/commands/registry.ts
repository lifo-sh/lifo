import type { Command } from './types.js';

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private lazy = new Map<string, () => Promise<{ default: Command }>>();

  register(name: string, command: Command): void {
    this.commands.set(name, command);
  }

  registerLazy(name: string, loader: () => Promise<{ default: Command }>): void {
    this.lazy.set(name, loader);
  }

  unregister(name: string): void {
    this.commands.delete(name);
    this.lazy.delete(name);
  }

  async resolve(name: string): Promise<Command | undefined> {
    const cmd = this.commands.get(name);
    if (cmd) return cmd;

    const loader = this.lazy.get(name);
    if (loader) {
      const mod = await loader();
      this.commands.set(name, mod.default);
      this.lazy.delete(name);
      return mod.default;
    }

    return undefined;
  }

  has(name: string): boolean {
    return this.commands.has(name) || this.lazy.has(name);
  }

  list(): string[] {
    const names = new Set([...this.commands.keys(), ...this.lazy.keys()]);
    return [...names].sort();
  }
}

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();

  // File system
  registry.registerLazy('ls', () => import('./fs/ls.js'));
  registry.registerLazy('cat', () => import('./fs/cat.js'));
  registry.registerLazy('mkdir', () => import('./fs/mkdir.js'));
  registry.registerLazy('rm', () => import('./fs/rm.js'));
  registry.registerLazy('cp', () => import('./fs/cp.js'));
  registry.registerLazy('mv', () => import('./fs/mv.js'));
  registry.registerLazy('touch', () => import('./fs/touch.js'));
  registry.registerLazy('find', () => import('./fs/find.js'));
  registry.registerLazy('tree', () => import('./fs/tree.js'));
  registry.registerLazy('stat', () => import('./fs/stat.js'));
  registry.registerLazy('ln', () => import('./fs/ln.js'));
  registry.registerLazy('du', () => import('./fs/du.js'));
  registry.registerLazy('df', () => import('./fs/df.js'));
  registry.registerLazy('chmod', () => import('./fs/chmod.js'));
  registry.registerLazy('file', () => import('./fs/file.js'));

  // Text processing
  registry.registerLazy('grep', () => import('./text/grep.js'));
  registry.registerLazy('head', () => import('./text/head.js'));
  registry.registerLazy('tail', () => import('./text/tail.js'));
  registry.registerLazy('wc', () => import('./text/wc.js'));
  registry.registerLazy('sort', () => import('./text/sort.js'));
  registry.registerLazy('uniq', () => import('./text/uniq.js'));
  registry.registerLazy('cut', () => import('./text/cut.js'));
  registry.registerLazy('tr', () => import('./text/tr.js'));
  registry.registerLazy('sed', () => import('./text/sed.js'));
  registry.registerLazy('awk', () => import('./text/awk.js'));

  // I/O utilities
  registry.registerLazy('tee', () => import('./io/tee.js'));
  registry.registerLazy('xargs', () => import('./io/xargs.js'));
  registry.registerLazy('yes', () => import('./io/yes.js'));
  registry.registerLazy('printf', () => import('./io/printf.js'));

  // System
  registry.registerLazy('env', () => import('./system/env.js'));
  registry.registerLazy('uname', () => import('./system/uname.js'));
  registry.registerLazy('date', () => import('./system/date.js'));
  registry.registerLazy('sleep', () => import('./system/sleep.js'));
  registry.registerLazy('uptime', () => import('./system/uptime.js'));
  registry.registerLazy('whoami', () => import('./system/whoami.js'));
  registry.registerLazy('hostname', () => import('./system/hostname.js'));
  registry.registerLazy('free', () => import('./system/free.js'));
  registry.registerLazy('which', () => import('./system/which.js'));

  // Network
  registry.registerLazy('curl', () => import('./net/curl.js'));
  registry.registerLazy('wget', () => import('./net/wget.js'));
  registry.registerLazy('ping', () => import('./net/ping.js'));
  registry.registerLazy('dig', () => import('./net/dig.js'));

  // Archive
  registry.registerLazy('tar', () => import('./archive/tar.js'));
  registry.registerLazy('gzip', () => import('./archive/gzip.js'));
  registry.registerLazy('gunzip', () => import('./archive/gunzip.js'));
  registry.registerLazy('zip', () => import('./archive/zip.js'));
  registry.registerLazy('unzip', () => import('./archive/unzip.js'));

  // System (continued)
  registry.registerLazy('node', () => import('./system/node.js'));

  // Filesystem (continued)
  registry.registerLazy('rmdir', () => import('./fs/rmdir.js'));
  registry.registerLazy('realpath', () => import('./fs/realpath.js'));
  registry.registerLazy('basename', () => import('./fs/basename.js'));
  registry.registerLazy('dirname', () => import('./fs/dirname.js'));
  registry.registerLazy('mktemp', () => import('./fs/mktemp.js'));
  registry.registerLazy('chown', () => import('./fs/chown.js'));

  // Text (continued)
  registry.registerLazy('diff', () => import('./text/diff.js'));
  registry.registerLazy('nl', () => import('./text/nl.js'));
  registry.registerLazy('rev', () => import('./text/rev.js'));
  registry.registerLazy('nano', () => import('./text/nano.js'));
  registry.registerLazy('less', () => import('./text/less.js'));
  registry.registerLazy('tac', () => import('./text/tac.js'));
  registry.registerLazy('seq', () => import('./text/seq.js'));
  registry.registerLazy('base64', () => import('./text/base64.js'));
  registry.registerLazy('strings', () => import('./text/strings.js'));

  // System (continued)
  registry.registerLazy('cal', () => import('./system/cal.js'));
  registry.registerLazy('bc', () => import('./system/bc.js'));
  registry.registerLazy('man', () => import('./system/man.js'));
  registry.registerLazy('sha256sum', () => import('./system/sha256sum.js'));
  registry.registerLazy('sl', () => import('./system/sl.js'));
  registry.registerLazy('fastfetch', () => import('./system/fastfetch.js'));
  registry.registerLazy('neofetch', () => import('./system/fastfetch.js'));

  return registry;
}
