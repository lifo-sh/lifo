// File operations shared by Finder and the desktop: the Trash (with Put Back), new folders,
// renaming, Get Info. All on the box's VFS.

import type { DesktopBox } from './box';
import { TRASH, HOME, basename, dirname, joinPath, formatBytes } from './box';
import { h, promptDialog, confirmDialog, infoDialog } from './ui';
import type { EventBus } from './EventBus';

const ORIGINS = `${TRASH}/.lifo-origins.json`;

export class FileOps {
  constructor(private box: DesktopBox, private bus: EventBus) {}

  private get vfs() {
    return this.box.vfs;
  }

  uniqueName(dir: string, name: string): string {
    if (!this.vfs.exists(joinPath(dir, name))) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${stem} ${i}${ext}`;
      if (!this.vfs.exists(joinPath(dir, candidate))) return candidate;
    }
  }

  private origins(): Record<string, string> {
    try {
      return JSON.parse(this.vfs.readFileString(ORIGINS));
    } catch {
      return {};
    }
  }

  private saveOrigins(o: Record<string, string>): void {
    this.vfs.writeFile(ORIGINS, JSON.stringify(o));
  }

  isInTrash(path: string): boolean {
    return path === TRASH || path.startsWith(TRASH + '/');
  }

  trashCount(): number {
    try {
      return this.vfs.readdir(TRASH).filter((e) => !e.name.startsWith('.')).length;
    } catch {
      return 0;
    }
  }

  moveToTrash(paths: string[]): void {
    if (!this.vfs.exists(TRASH)) this.vfs.mkdir(TRASH, { recursive: true });
    const origins = this.origins();
    for (const p of paths) {
      if (!this.vfs.exists(p) || this.isInTrash(p) || p === HOME || p === '/') continue;
      const name = this.uniqueName(TRASH, basename(p));
      this.vfs.rename(p, joinPath(TRASH, name));
      origins[name] = p;
    }
    this.saveOrigins(origins);
    this.bus.emit('trash:change', {});
  }

  putBack(path: string): void {
    const origins = this.origins();
    const name = basename(path);
    const to = origins[name] ?? joinPath(HOME, name);
    const dir = dirname(to);
    if (!this.vfs.exists(dir)) this.vfs.mkdir(dir, { recursive: true });
    this.vfs.rename(path, joinPath(dir, this.uniqueName(dir, basename(to))));
    delete origins[name];
    this.saveOrigins(origins);
    this.bus.emit('trash:change', {});
  }

  async emptyTrash(): Promise<void> {
    const n = this.trashCount();
    if (!n) return;
    const ok = await confirmDialog('Empty the Trash?', `${n} item${n > 1 ? 's' : ''} will be deleted. You can't undo this.`, 'Empty Trash', true);
    if (!ok) return;
    for (const e of this.vfs.readdir(TRASH)) {
      const p = joinPath(TRASH, e.name);
      if (e.type === 'directory') this.vfs.rmdirRecursive(p);
      else this.vfs.unlink(p);
    }
    this.bus.emit('trash:change', {});
  }

  async newFolder(dir: string): Promise<string | null> {
    const name = await promptDialog('New Folder', `In ${dir.replace(HOME, '~')}`, this.uniqueName(dir, 'untitled folder'), 'Create');
    if (!name) return null;
    const p = joinPath(dir, this.uniqueName(dir, name.replace(/\//g, '-')));
    this.vfs.mkdir(p, { recursive: true });
    return p;
  }

  async newFile(dir: string): Promise<string | null> {
    const name = await promptDialog('New File', `In ${dir.replace(HOME, '~')}`, this.uniqueName(dir, 'untitled.txt'), 'Create');
    if (!name) return null;
    const p = joinPath(dir, this.uniqueName(dir, name.replace(/\//g, '-')));
    this.vfs.writeFile(p, '');
    return p;
  }

  async rename(path: string): Promise<string | null> {
    const name = await promptDialog('Rename', path.replace(HOME, '~'), basename(path), 'Rename');
    if (!name || name === basename(path)) return null;
    const to = joinPath(dirname(path), name.replace(/\//g, '-'));
    if (this.vfs.exists(to)) {
      await confirmDialog('That name is taken', `“${name}” already exists in this folder.`, 'OK');
      return null;
    }
    this.vfs.rename(path, to);
    return to;
  }

  duplicate(path: string): string {
    const dir = dirname(path);
    const dot = basename(path).lastIndexOf('.');
    const base = basename(path);
    const copyName = this.uniqueName(dir, dot > 0 ? `${base.slice(0, dot)} copy${base.slice(dot)}` : `${base} copy`);
    const to = joinPath(dir, copyName);
    const copy = (from: string, dest: string) => {
      if (this.vfs.stat(from).type === 'directory') {
        this.vfs.mkdir(dest, { recursive: true });
        for (const e of this.vfs.readdir(from)) copy(joinPath(from, e.name), joinPath(dest, e.name));
      } else this.vfs.copyFile(from, dest);
    };
    copy(path, to);
    return to;
  }

  move(paths: string[], toDir: string): void {
    for (const p of paths) {
      if (p === toDir || toDir.startsWith(p + '/') || dirname(p) === toDir) continue;
      this.vfs.rename(p, joinPath(toDir, this.uniqueName(toDir, basename(p))));
    }
    if (paths.some((p) => this.isInTrash(p))) this.bus.emit('trash:change', {});
  }

  getInfo(path: string): void {
    const st = this.vfs.stat(path);
    let size = st.size;
    let count = 0;
    if (st.type === 'directory') {
      const u = this.box.usage(path, 5000);
      size = u.bytes;
      count = u.files;
    }
    const row = (k: string, v: string) => h('div', { class: 'lf-info-row' }, h('span', {}, k), h('span', {}, v));
    const kind = st.type === 'directory' ? 'Folder' : path.includes('.') ? `${path.split('.').pop()!.toUpperCase()} file` : 'File';
    infoDialog(
      `${basename(path)} Info`,
      h(
        'div',
        { class: 'lf-info' },
        row('Kind', kind),
        row('Size', `${formatBytes(size)}${st.type === 'directory' ? ` in ${count}${count >= 5000 ? '+' : ''} files` : ''}`),
        row('Where', dirname(path)),
        row('Created', new Date(st.ctime).toLocaleString()),
        row('Modified', new Date(st.mtime).toLocaleString()),
        row('Permissions', (st.mode & 0o777).toString(8).padStart(3, '0')),
      ),
    );
  }
}
