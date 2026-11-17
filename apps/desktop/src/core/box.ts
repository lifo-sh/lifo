// The one Lifo box behind the whole desktop. Every app shares its filesystem, processes and
// ports: Finder lists the same files the Terminal sees, Activity Monitor kills what a Terminal
// started, the Browser shows the servers it runs. Each Terminal tab gets its own shell over the
// same kernel (like a new tab in a real terminal app). Files persist in IndexedDB.

import { Sandbox, Shell, ServiceWorkerBridge } from '@lifo-sh/core';
import type { CommandRegistry, ITerminal } from '@lifo-sh/core';

// Lifo packages that come with the desktop, loaded on first use (like lifo-sh and lifo.sh).
const DEFAULT_PACKAGES: Record<string, () => Promise<{ default: (ctx: never) => Promise<number> }>> = {
  git: () => import('lifo-pkg-git') as never,
  vi: () => import('lifo-pkg-vi') as never,
  vim: () => import('lifo-pkg-vi') as never,
  nano: () => import('lifo-pkg-nano') as never,
  less: () => import('lifo-pkg-less') as never,
  python: () => import('lifo-pkg-python') as never,
  python3: () => import('lifo-pkg-python') as never,
  pip: () => import('lifo-pkg-python').then((m) => ({ default: (m as unknown as { pip: never }).pip })) as never,
  pip3: () => import('lifo-pkg-python').then((m) => ({ default: (m as unknown as { pip: never }).pip })) as never,
};

export const HOME = '/home/user';
export const TRASH = `${HOME}/.Trash`;

export class DesktopBox {
  readonly bootedAt = Date.now();
  private bridge: ServiceWorkerBridge | null = null;
  private bridgeReady: Promise<boolean> | null = null;

  private constructor(readonly sandbox: Sandbox) {}

  static async create(): Promise<DesktopBox> {
    const sandbox = await Sandbox.create({ persist: true, cwd: HOME });
    const registry = sandbox.shell.getRegistry();
    for (const [name, load] of Object.entries(DEFAULT_PACKAGES)) {
      if (registry.has(name)) continue; // installed with `lifo install`: that one wins
      registry.register(name, async (ctx) => (await load()).default(ctx as never));
    }
    const vfs = sandbox.kernel.vfs;
    for (const dir of ['Desktop', 'Documents', 'Downloads', 'Projects', '.Trash']) {
      const p = `${HOME}/${dir}`;
      if (!vfs.exists(p)) vfs.mkdir(p, { recursive: true });
    }
    const welcome = `${HOME}/Desktop/Welcome.md`;
    if (!vfs.exists(welcome) && !vfs.exists(`${HOME}/.lifo-desktop-welcomed`)) {
      vfs.writeFile(welcome, WELCOME);
      vfs.writeFile(`${HOME}/.lifo-desktop-welcomed`, '');
    }
    return new DesktopBox(sandbox);
  }

  get vfs() {
    return this.sandbox.kernel.vfs;
  }

  get registry(): CommandRegistry {
    return this.sandbox.shell.getRegistry();
  }

  get processes() {
    return this.sandbox.kernel.processRegistry;
  }

  /** Ports with a server listening in the box. */
  ports(): number[] {
    return [...this.sandbox.kernel.portRegistry.keys()].sort((a, b) => a - b);
  }

  /** A new interactive shell on this box, drawn in `terminal`. */
  async newShell(terminal: ITerminal, cwd = HOME): Promise<Shell> {
    const env: Record<string, string> = { ...this.sandbox.env, PWD: cwd };
    const shell = new Shell(terminal, this.vfs, this.registry, env, this.processes);
    await shell.sourceFile('/etc/profile');
    await shell.sourceFile(`${env.HOME || HOME}/.bashrc`);
    if (this.vfs.exists(cwd)) shell.setCwd(cwd);
    const before = new Set(this.processes.getAllPIDs());
    shell.start({ sourceRc: true });
    const pid = this.processes.getAllPIDs().find((p) => !before.has(p));
    if (pid !== undefined) this.shellPids.set(shell, pid);
    return shell;
  }

  /** A terminal tab closed: end its shell process (and what it started in the foreground). */
  endShell(shell: Shell | null): void {
    const pid = shell ? this.shellPids.get(shell) : undefined;
    if (pid === undefined) return;
    this.processes.kill(pid);
    this.processes.reap(pid);
    this.shellPids.delete(shell!);
  }

  private shellPids = new WeakMap<Shell, number>();

  /** Run a line in the background shell (not a terminal); for quick actions. */
  run(line: string, cwd?: string) {
    return this.sandbox.commands.run(line, { cwd });
  }

  /**
   * Start a long-running command (a server) as a background job in `cwd`. A subshell, because a
   * background job started by commands.run() doesn't keep run()'s cwd option.
   */
  startInBackground(cmd: string, cwd: string) {
    return this.sandbox.commands.run(`(cd '${cwd.replace(/'/g, `'\\''`)}' && ${cmd}) &`);
  }

  /**
   * URL that shows a box port in an <iframe>, through Lifo's preview service worker; null when
   * service workers aren't available. On lifo.sh the worker is the playground's (/playground/sw.js,
   * scope /_sw/); standalone, this app serves its own.
   */
  async previewUrl(port: number, path = '/'): Promise<string | null> {
    if (!this.bridgeReady) {
      this.bridge = new ServiceWorkerBridge(this.sandbox.kernel.portRegistry);
      const onSite = import.meta.env.BASE_URL === '/desktop/';
      const swUrl = onSite ? '/playground/sw.js' : `${import.meta.env.BASE_URL}sw.js`;
      this.bridgeReady = this.bridge.connect(swUrl, '/_sw/');
    }
    if (!(await this.bridgeReady) || !this.bridge) return null;
    return `/_sw/${this.bridge.boxId}/${port}${path.startsWith('/') ? path : '/' + path}`;
  }

  /** File count and total bytes under `root` (stops early on huge trees). */
  usage(root = '/', limit = 20000): { files: number; bytes: number; partial: boolean } {
    let files = 0;
    let bytes = 0;
    let partial = false;
    const walk = (dir: string) => {
      if (partial) return;
      let entries;
      try {
        entries = this.vfs.readdirStat(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (dir === '/' && (e.name === 'proc' || e.name === 'dev')) continue;
        const p = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
        if (e.type === 'directory') walk(p);
        else {
          files++;
          bytes += e.size;
          if (files >= limit) {
            partial = true;
            return;
          }
        }
      }
    };
    walk(root);
    return { files, bytes, partial };
  }
}

const WELCOME = `# Welcome to Lifo Desktop

Everything here runs in this browser tab: a small Linux-like OS (Lifo), its files,
processes and servers. Nothing is sent to a server.

- **Finder** browses the box's files. Drag a file to the Trash in the Dock to delete it.
- **Terminal** is a real shell: try \`ls\`, \`node -e "console.log(1+1)"\`, \`git init\`, \`python3\`.
- Start a server (\`npx serve\` or \`node server.js\`) and open it in **Browser**.
- **Activity Monitor** shows what's running; **System Settings** changes the wallpaper and Dock.

Shortcuts (Option is ⌥):
⌥Space Spotlight · ⌥Tab switch apps · ⌥W close window · ⌥Q quit app · ⌥N new window · ⌥M minimize · F3 show all windows

Your files are kept in this browser (IndexedDB). Lifo menu → Download Snapshot saves them as a file.
`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const basename = (p: string) => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop() || '/');
export const dirname = (p: string) => {
  const parts = p.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
};
export const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
