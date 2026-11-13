import { resolve, dirname, basename } from '../../utils/path.js';
import { encode, decode } from '../../utils/encoding.js';
import { getMimeType } from '../../utils/mime.js';
import { INode, Stat, Dirent, VFSError, ErrorCode, VirtualProvider, MountProvider } from './types.js';
import type { FileType, VFSWatchEvent, VFSWatchListener } from './types.js';
import { ContentStore, CHUNK_THRESHOLD } from '../storage/ContentStore.js';
import { EventEmitter } from '../../node-compat/events.js';

/** Runtime check: does a provider implement the full MountProvider interface? */
function isMountProvider(p: VirtualProvider): p is MountProvider {
  return (
    typeof (p as MountProvider).unlink === 'function' &&
    typeof (p as MountProvider).mkdir === 'function' &&
    typeof (p as MountProvider).rmdir === 'function' &&
    typeof (p as MountProvider).rename === 'function' &&
    typeof (p as MountProvider).copyFile === 'function'
  );
}

/** Symlinks followed while resolving one path before giving up, as Linux does (MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;

interface MountEntry {
  path: string;            // normalised absolute path, e.g. "/mnt/project"
  provider: VirtualProvider | MountProvider;
}

export class VFS {
  private root: INode;
  /**
   * Mount table -- kept sorted longest-prefix-first so that the first match
   * during lookup is always the most specific.
   */
  private mounts: MountEntry[] = [];
  private emitter = new EventEmitter();
  /**
   * Set once a symlink is created in (or loaded into) the in-memory tree. Until then, and while no
   * mounted provider reports one, paths are used as given: following links costs a lookup per
   * path component, which nothing should pay for before the first link exists.
   */
  private treeHasSymlinks = false;
  onChange?: () => void;

  /** Content store for chunked large files. Optional -- without it all data stays inline. */
  readonly contentStore: ContentStore;

  constructor(contentStore?: ContentStore) {
    this.root = this.createNode('directory', '');
    this.contentStore = contentStore ?? new ContentStore();
  }

  // ─── Watch API ───

  watch(listener: VFSWatchListener): () => void;
  watch(path: string, listener: VFSWatchListener): () => void;
  watch(pathOrListener: string | VFSWatchListener, maybeListener?: VFSWatchListener): () => void {
    if (typeof pathOrListener === 'function') {
      // watch(listener) — global watch
      const listener = pathOrListener;
      this.emitter.on('change', listener as (...args: unknown[]) => void);
      return () => this.emitter.off('change', listener as (...args: unknown[]) => void);
    }

    // watch(path, listener) — scoped watch
    const prefix = this.toAbsolute(pathOrListener);
    const listener = maybeListener!;
    const scoped = (event: VFSWatchEvent) => {
      if (event.path === prefix || event.path.startsWith(prefix + '/')) {
        listener(event);
      }
      if (event.oldPath && (event.oldPath === prefix || event.oldPath.startsWith(prefix + '/'))) {
        listener(event);
      }
    };
    this.emitter.on('change', scoped as (...args: unknown[]) => void);
    return () => this.emitter.off('change', scoped as (...args: unknown[]) => void);
  }

  private notify(event: VFSWatchEvent): void {
    this.emitter.emit('change', event);
    this.onChange?.();
  }

  // ─── Mount management ───

  /**
   * Mount a provider at an arbitrary path.
   * The path is normalised to an absolute path (e.g. "/mnt/project").
   */
  mount(path: string, provider: VirtualProvider | MountProvider): void {
    const abs = this.toAbsolute(path);

    // Replace if already mounted at this exact path
    const idx = this.mounts.findIndex((m) => m.path === abs);
    if (idx !== -1) {
      this.mounts[idx] = { path: abs, provider };
    } else {
      this.mounts.push({ path: abs, provider });
    }

    // Re-sort: longest path first (most specific wins)
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  /**
   * Unmount the provider at the given path.
   */
  unmount(path: string): void {
    const abs = this.toAbsolute(path);
    const idx = this.mounts.findIndex((m) => m.path === abs);
    if (idx === -1) {
      throw new VFSError(ErrorCode.EINVAL, `'${path}': not mounted`);
    }
    this.mounts.splice(idx, 1);
  }

  /**
   * Backward-compatible alias for `mount`.
   * Previously the only way to register a VirtualProvider at a root-level prefix.
   */
  registerProvider(prefix: string, provider: VirtualProvider): void {
    this.mount(prefix, provider);
  }

  getRoot(): INode {
    return this.root;
  }

  loadFromSerialized(root: INode): void {
    this.root = root;
    const hasLink = (node: INode): boolean => {
      if (node.type === 'symlink') return true;
      for (const child of node.children.values()) if (hasLink(child)) return true;
      return false;
    };
    this.treeHasSymlinks = hasLink(root);
  }

  // ─── Provider resolution ───

  private getProvider(path: string): { provider: VirtualProvider | MountProvider; subpath: string } | null {
    const abs = this.toAbsolute(path);
    for (const entry of this.mounts) {
      if (abs === entry.path || abs.startsWith(entry.path + '/')) {
        const subpath = abs === entry.path ? '/' : abs.slice(entry.path.length);
        return { provider: entry.provider, subpath };
      }
    }
    return null;
  }

  /** The mount provider for `abs` when it can write (a MountProvider), or a read-only error. */
  private writableProvider(abs: string, label = abs): { provider: MountProvider; subpath: string } | null {
    const vp = this.getProvider(abs);
    if (!vp) return null;
    if (isMountProvider(vp.provider)) return { provider: vp.provider, subpath: vp.subpath };
    throw new VFSError(ErrorCode.EINVAL, `'${label}': read-only virtual filesystem`);
  }

  // ─── Symlinks: path resolution ───

  private mayHaveSymlinks(): boolean {
    if (this.treeHasSymlinks) return true;
    for (const m of this.mounts) {
      if ((m.provider as MountProvider).hasSymlinks?.()) return true;
    }
    return false;
  }

  /**
   * The target of the symlink at `abs`, whose parent path is already free of symlinks; null when
   * `abs` isn't a symlink (or doesn't exist).
   */
  private linkTarget(abs: string): string | null {
    const vp = this.getProvider(abs);
    if (vp) {
      const p = vp.provider as MountProvider;
      if (!p.hasSymlinks?.() || !p.lstat || !p.readlink) return null;
      try {
        return p.lstat(vp.subpath).type === 'symlink' ? p.readlink(vp.subpath) : null;
      } catch {
        return null;
      }
    }
    if (!this.treeHasSymlinks) return null;
    const node = this.lookup(abs);
    return node?.type === 'symlink' ? (node.target ?? null) : null;
  }

  /** The tree node at `abs` without following anything, or null. */
  private lookup(abs: string): INode | null {
    let node = this.root;
    for (const part of abs.split('/')) {
      if (!part) continue;
      if (node.type !== 'directory') return null;
      const child = node.children.get(part);
      if (!child) return null;
      node = child;
    }
    return node;
  }

  /**
   * `path` made absolute with every symlink resolved, the last component only when `followLast`
   * (lstat, readlink, unlink, rename and rmdir act on a link itself). Components that don't exist
   * are kept as they are, so the operation reports ENOENT itself.
   */
  private real(path: string, followLast = true): string {
    const abs = this.toAbsolute(path);
    if (!this.mayHaveSymlinks()) return abs;
    let pending = abs.split('/').filter(Boolean);
    let resolved = '';
    let hops = 0;
    while (pending.length > 0) {
      const part = pending.shift()!;
      const next = `${resolved}/${part}`;
      if (pending.length === 0 && !followLast) {
        resolved = next;
        break;
      }
      const target = this.linkTarget(next);
      if (target === null) {
        resolved = next;
        continue;
      }
      if (++hops > MAX_SYMLINK_HOPS) {
        throw new VFSError(ErrorCode.ELOOP, `'${path}': too many levels of symbolic links`);
      }
      const targetAbs = resolve(target.startsWith('/') ? '/' : resolved || '/', target);
      pending = [...targetAbs.split('/').filter(Boolean), ...pending];
      resolved = '';
    }
    return resolved || '/';
  }

  // ─── Internal helpers ───

  private createNode(type: FileType, name: string): INode {
    const now = Date.now();
    return {
      type,
      name,
      data: new Uint8Array(0),
      children: new Map(),
      ctime: now,
      mtime: now,
      mode: type === 'directory' ? 0o755 : type === 'symlink' ? 0o777 : 0o644,
    };
  }

  private resolveNode(path: string): INode {
    const abs = this.toAbsolute(path);
    if (abs === '/') return this.root;

    const parts = abs.split('/').filter(Boolean);
    let node = this.root;

    for (const part of parts) {
      if (node.type !== 'directory') {
        throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
      }
      const child = node.children.get(part);
      if (!child) {
        throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
      }
      node = child;
    }

    return node;
  }

  private resolveParent(path: string): { parent: INode; name: string } {
    const abs = this.toAbsolute(path);
    const dir = dirname(abs);
    const name = basename(abs);
    const parent = this.resolveNode(dir);

    if (parent.type !== 'directory') {
      throw new VFSError(ErrorCode.ENOTDIR, `'${dir}': not a directory`);
    }

    return { parent, name };
  }

  private toAbsolute(path: string): string {
    return resolve('/', path);
  }

  private static statOfNode(node: INode): Stat {
    const stat: Stat = {
      type: node.type,
      size:
        node.type === 'file'
          ? (node.storedSize ?? node.data.length)
          : node.type === 'symlink'
            ? encode(node.target ?? '').length
            : node.children.size,
      ctime: node.ctime,
      mtime: node.mtime,
      mode: node.mode,
    };
    if (node.mime) stat.mime = node.mime;
    return stat;
  }

  // ─── File operations ───

  readFile(path: string): Uint8Array {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) return vp.provider.readFile(vp.subpath);

    const node = this.resolveNode(abs);
    if (node.type === 'directory') {
      throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
    }

    // Chunked file: reassemble from content store
    if (node.chunks) {
      const data = this.contentStore.loadChunked(node.chunks);
      if (data) return data;
      // Chunks evicted from cache -- data is lost (should not happen in normal use)
      return new Uint8Array(0);
    }

    return node.data;
  }

  readFileString(path: string): string {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) return vp.provider.readFileString(vp.subpath);

    return decode(this.readFile(abs));
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) {
      if (vp.provider.writeFile) {
        // Only real mounts report changes: a write to /dev/null isn't one (and every event
        // schedules a save of the tree).
        const mount = isMountProvider(vp.provider);
        const existed = mount && vp.provider.exists(vp.subpath);
        vp.provider.writeFile(vp.subpath, content);
        if (mount) this.notify({ type: existed ? 'modify' : 'create', path: abs, fileType: 'file' });
        return;
      }
      throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
    }

    const data = typeof content === 'string' ? encode(content) : content;
    const { parent, name } = this.resolveParent(abs);
    const mime = getMimeType(name);
    const existing = parent.children.get(name);

    if (existing) {
      if (existing.type === 'directory') {
        throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
      }
      // Clean up old chunks if transitioning from chunked
      if (existing.chunks) {
        this.contentStore.deleteChunked(existing.chunks);
      }
      this.applyFileContent(existing, data);
      existing.mtime = Date.now();
      existing.mime = mime;
      this.notify({ type: 'modify', path: abs, fileType: 'file' });
    } else {
      const node = this.createNode('file', name);
      this.applyFileContent(node, data);
      node.mime = mime;
      parent.children.set(name, node);
      this.notify({ type: 'create', path: abs, fileType: 'file' });
    }
  }

  /**
   * Store file content -- inline for small files, chunked for large files.
   */
  private applyFileContent(node: INode, data: Uint8Array): void {
    if (data.byteLength >= CHUNK_THRESHOLD) {
      // Large file: chunk into content store
      node.chunks = this.contentStore.storeChunked(data);
      node.storedSize = data.byteLength;
      node.data = new Uint8Array(0); // keep INode lightweight
      node.blobRef = undefined;
    } else {
      // Small file: store inline
      node.data = data;
      node.chunks = undefined;
      node.storedSize = undefined;
      node.blobRef = undefined;
    }
  }

  appendFile(path: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? encode(content) : content;
    const abs = this.real(path);

    const vp = this.getProvider(abs);
    if (vp && !isMountProvider(vp.provider)) {
      // A virtual device (/dev/null, /dev/stdout): appending is writing.
      if (!vp.provider.writeFile) throw new VFSError(ErrorCode.EINVAL, `'${path}': read-only virtual filesystem`);
      vp.provider.writeFile(vp.subpath, data);
      return;
    }
    const mp = vp as { provider: MountProvider; subpath: string } | null;
    if (mp) {
      if (!mp.provider.exists(mp.subpath)) {
        this.writeFile(abs, data);
        return;
      }
      if (mp.provider.appendFile) {
        mp.provider.appendFile(mp.subpath, data);
      } else {
        const existing = mp.provider.readFile(mp.subpath);
        const merged = new Uint8Array(existing.byteLength + data.byteLength);
        merged.set(existing, 0);
        merged.set(data, existing.byteLength);
        mp.provider.writeFile(mp.subpath, merged);
      }
      this.notify({ type: 'modify', path: abs, fileType: 'file' });
      return;
    }

    try {
      const node = this.resolveNode(abs);
      if (node.type === 'directory') {
        throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
      }

      if (node.chunks) {
        // Chunked file: read existing, concatenate, re-chunk
        const existing = this.contentStore.loadChunked(node.chunks) ?? new Uint8Array(0);
        const merged = new Uint8Array(existing.byteLength + data.byteLength);
        merged.set(existing, 0);
        merged.set(data, existing.byteLength);
        this.contentStore.deleteChunked(node.chunks);
        this.applyFileContent(node, merged);
      } else {
        // Inline file: concatenate, possibly promote to chunked
        const merged = new Uint8Array(node.data.length + data.length);
        merged.set(node.data, 0);
        merged.set(data, node.data.length);
        this.applyFileContent(node, merged);
      }

      node.mtime = Date.now();
      this.notify({ type: 'modify', path: abs, fileType: 'file' });
    } catch (e) {
      if (e instanceof VFSError && e.code === 'ENOENT') {
        this.writeFile(abs, data);
      } else {
        throw e;
      }
    }
  }

  exists(path: string): boolean {
    let abs: string;
    try {
      abs = this.real(path);
    } catch {
      return false; // a symlink loop
    }
    const vp = this.getProvider(abs);
    if (vp) return vp.provider.exists(vp.subpath);

    try {
      this.resolveNode(abs);
      return true;
    } catch {
      return false;
    }
  }

  stat(path: string): Stat {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) return vp.provider.stat(vp.subpath);

    return VFS.statOfNode(this.resolveNode(abs));
  }

  /** stat() of the path itself: a symlink reports type 'symlink' instead of its target's stat. */
  lstat(path: string): Stat {
    const abs = this.real(path, false);
    const vp = this.getProvider(abs);
    if (vp) {
      const p = vp.provider as MountProvider;
      return p.lstat ? p.lstat(vp.subpath) : p.stat(vp.subpath);
    }
    return VFS.statOfNode(this.resolveNode(abs));
  }

  unlink(path: string): void {
    const abs = this.real(path, false);
    const mp = this.writableProvider(abs, path);
    if (mp) {
      const fileType = this.providerType(mp.provider, mp.subpath);
      mp.provider.unlink(mp.subpath);
      this.notify({ type: 'delete', path: abs, fileType: fileType === 'symlink' ? 'symlink' : 'file' });
      return;
    }

    const { parent, name } = this.resolveParent(abs);
    const node = parent.children.get(name);

    if (!node) {
      throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
    }
    if (node.type === 'directory') {
      throw new VFSError(ErrorCode.EISDIR, `'${path}': is a directory`);
    }

    // Clean up chunks from content store
    if (node.chunks) {
      this.contentStore.deleteChunked(node.chunks);
    }

    parent.children.delete(name);
    this.notify({ type: 'delete', path: abs, fileType: node.type });
  }

  /** The type of an entry on a provider, without following a symlink; 'file' if it can't tell. */
  private providerType(provider: MountProvider, subpath: string): FileType {
    try {
      return (provider.lstat ? provider.lstat(subpath) : provider.stat(subpath)).type;
    } catch {
      return 'file';
    }
  }

  rename(oldPath: string, newPath: string): void {
    const oldAbs = this.real(oldPath, false);
    const newAbs = this.real(newPath, false);
    const vpOld = this.getProvider(oldAbs);
    const vpNew = this.getProvider(newAbs);

    // If both paths are on the same mount and it supports MountProvider, delegate
    if (vpOld && vpNew && vpOld.provider === vpNew.provider && isMountProvider(vpOld.provider)) {
      const fileType = this.providerType(vpOld.provider, vpOld.subpath);
      vpOld.provider.rename(vpOld.subpath, vpNew.subpath);
      this.notify({ type: 'rename', path: newAbs, oldPath: oldAbs, fileType });
      return;
    }

    // If either path is on a provider that doesn't support rename, fall through
    // to in-memory rename (or error if source is on a provider)
    if (vpOld) {
      throw new VFSError(ErrorCode.EINVAL, `'${oldPath}': cannot rename across mount boundaries`);
    }

    const { parent: oldParent, name: oldName } = this.resolveParent(oldAbs);
    const node = oldParent.children.get(oldName);

    if (!node) {
      throw new VFSError(ErrorCode.ENOENT, `'${oldPath}': no such file or directory`);
    }

    if (vpNew) {
      throw new VFSError(ErrorCode.EINVAL, `'${newPath}': cannot rename across mount boundaries`);
    }

    const { parent: newParent, name: newName } = this.resolveParent(newAbs);
    node.name = newName;
    node.mtime = Date.now();
    newParent.children.set(newName, node);
    oldParent.children.delete(oldName);
    this.notify({ type: 'rename', path: newAbs, oldPath: oldAbs, fileType: node.type });
  }

  copyFile(src: string, dest: string): void {
    const srcAbs = this.real(src);
    const destAbs = this.real(dest);
    const vpSrc = this.getProvider(srcAbs);
    const vpDest = this.getProvider(destAbs);

    // If both on the same MountProvider, delegate
    if (vpSrc && vpDest && vpSrc.provider === vpDest.provider && isMountProvider(vpSrc.provider)) {
      const existed = vpDest.provider.exists(vpDest.subpath);
      vpSrc.provider.copyFile(vpSrc.subpath, vpDest.subpath);
      this.notify({ type: existed ? 'modify' : 'create', path: destAbs, fileType: 'file' });
      return;
    }

    // Otherwise, read from source and write to dest (works across mounts)
    const srcData = this.readFile(srcAbs);
    const data = new Uint8Array(srcData);
    this.writeFile(destAbs, data); // writeFile already calls notify
  }

  touch(path: string): void {
    const abs = this.real(path);
    const mp = this.getProvider(abs);
    if (mp) {
      if (!mp.provider.exists(mp.subpath)) {
        this.writeFile(abs, ''); // writeFile already calls notify
        return;
      }
      if (!isMountProvider(mp.provider)) return; // touching /dev/null: nothing to do
      const p = mp.provider;
      if (p.utimes) p.utimes(mp.subpath, Date.now());
      this.notify({ type: 'modify', path: abs, fileType: this.providerType(p, mp.subpath) });
      return;
    }
    try {
      const node = this.resolveNode(abs);
      node.mtime = Date.now();
      this.notify({ type: 'modify', path: abs, fileType: node.type });
    } catch (e) {
      if (e instanceof VFSError && e.code === 'ENOENT') {
        this.writeFile(abs, ''); // writeFile already calls notify
      } else {
        throw e;
      }
    }
  }

  // ─── Permissions, timestamps, links ───

  /** Set the permission bits (follows symlinks). A provider without chmod ignores it, as before. */
  chmod(path: string, mode: number): void {
    const abs = this.real(path);
    const bits = mode & 0o7777;
    const vp = this.getProvider(abs);
    if (vp) {
      if (!vp.provider.exists(vp.subpath)) throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
      const p = vp.provider as MountProvider;
      if (!p.chmod) return;
      p.chmod(vp.subpath, bits);
      this.notify({ type: 'attrib', path: abs, fileType: this.providerType(p, vp.subpath) });
      return;
    }
    const node = this.resolveNode(abs);
    node.mode = bits;
    this.notify({ type: 'attrib', path: abs, fileType: node.type });
  }

  /**
   * Set the modification time (follows symlinks). Times are ms since the epoch; the access time
   * isn't kept (stat reports mtime for it). A provider without utimes ignores it, as before.
   */
  utimes(path: string, _atime: number, mtime: number): void {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) {
      if (!vp.provider.exists(vp.subpath)) throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
      const p = vp.provider as MountProvider;
      if (!p.utimes) return;
      p.utimes(vp.subpath, mtime);
      this.notify({ type: 'attrib', path: abs, fileType: this.providerType(p, vp.subpath) });
      return;
    }
    const node = this.resolveNode(abs);
    node.mtime = mtime;
    this.notify({ type: 'attrib', path: abs, fileType: node.type });
  }

  /** Create a symlink at `path` pointing to `target` (relative targets resolve from its directory). */
  symlink(target: string, path: string): void {
    const abs = this.real(path, false);
    const vp = this.getProvider(abs);
    if (vp) {
      const p = vp.provider as MountProvider;
      if (!isMountProvider(vp.provider) || !p.symlink) {
        throw new VFSError(ErrorCode.EINVAL, `'${path}': symbolic links aren't supported on this mount`);
      }
      p.symlink(target, vp.subpath);
      this.notify({ type: 'create', path: abs, fileType: 'symlink' });
      return;
    }
    const { parent, name } = this.resolveParent(abs);
    if (parent.children.has(name)) {
      throw new VFSError(ErrorCode.EEXIST, `'${path}': file exists`);
    }
    const node = this.createNode('symlink', name);
    node.target = target;
    parent.children.set(name, node);
    this.treeHasSymlinks = true;
    this.notify({ type: 'create', path: abs, fileType: 'symlink' });
  }

  /** The target of the symlink at `path`, as it was given; EINVAL if it isn't a symlink. */
  readlink(path: string): string {
    const abs = this.real(path, false);
    const vp = this.getProvider(abs);
    if (vp) {
      const p = vp.provider as MountProvider;
      if (p.readlink) return p.readlink(vp.subpath);
      if (!p.exists(vp.subpath)) throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
      throw new VFSError(ErrorCode.EINVAL, `'${path}': not a symbolic link`);
    }
    const node = this.resolveNode(abs);
    if (node.type !== 'symlink') throw new VFSError(ErrorCode.EINVAL, `'${path}': not a symbolic link`);
    return node.target ?? '';
  }

  /** The absolute path with every symlink resolved; ENOENT if it doesn't exist. */
  realpath(path: string): string {
    const abs = this.real(path);
    if (!this.exists(abs)) throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
    return abs;
  }

  // ─── Directory operations ───

  mkdir(path: string, options?: { recursive?: boolean }): void {
    // `mkdir -p` goes through a symlink to a directory; plain mkdir on any existing name is EEXIST.
    const abs = this.real(path, !!options?.recursive);
    const mp = this.writableProvider(abs, path);
    if (mp) {
      const existed = mp.provider.exists(mp.subpath);
      mp.provider.mkdir(mp.subpath, options);
      if (!existed) this.notify({ type: 'create', path: abs, fileType: 'directory' });
      return;
    }

    if (options?.recursive) {
      const parts = abs.split('/').filter(Boolean);
      let current = this.root;
      let currentPath = '';

      for (const part of parts) {
        currentPath += '/' + part;
        let child = current.children.get(part);
        if (!child) {
          child = this.createNode('directory', part);
          current.children.set(part, child);
          this.notify({ type: 'create', path: currentPath, fileType: 'directory' });
        } else if (child.type !== 'directory') {
          throw new VFSError(ErrorCode.ENOTDIR, `'${part}': not a directory`);
        }
        current = child;
      }
      return;
    }

    const { parent, name } = this.resolveParent(abs);

    if (parent.children.has(name)) {
      throw new VFSError(ErrorCode.EEXIST, `'${path}': file exists`);
    }

    const node = this.createNode('directory', name);
    parent.children.set(name, node);
    this.notify({ type: 'create', path: abs, fileType: 'directory' });
  }

  rmdir(path: string): void {
    const abs = this.real(path, false);
    const mp = this.writableProvider(abs, path);
    if (mp) {
      mp.provider.rmdir(mp.subpath);
      this.notify({ type: 'delete', path: abs, fileType: 'directory' });
      return;
    }

    const { parent, name } = this.resolveParent(abs);
    const node = parent.children.get(name);

    if (!node) {
      throw new VFSError(ErrorCode.ENOENT, `'${path}': no such file or directory`);
    }
    if (node.type !== 'directory') {
      throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
    }
    if (node.children.size > 0) {
      throw new VFSError(ErrorCode.ENOTEMPTY, `'${path}': directory not empty`);
    }

    parent.children.delete(name);
    this.notify({ type: 'delete', path: abs, fileType: 'directory' });
  }

  readdir(path: string): Dirent[] {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) return vp.provider.readdir(vp.subpath);

    const node = this.resolveNode(abs);
    if (node.type !== 'directory') {
      throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
    }

    const entries = Array.from(node.children.values()).map((child) => ({
      name: child.name,
      type: child.type,
    }));

    // Inject mount point directories that are direct children of the current path
    const prefix = abs === '/' ? '/' : abs + '/';

    for (const mount of this.mounts) {
      let candidate: string | null = null;

      if (abs === '/') {
        // At root: inject first segment of each mount path
        if (mount.path.startsWith('/') && mount.path !== '/') {
          const segments = mount.path.slice(1).split('/');
          candidate = segments[0];
        }
      } else if (mount.path.startsWith(prefix)) {
        // At a deeper directory: inject the next path segment after the prefix
        const remainder = mount.path.slice(prefix.length);
        const segments = remainder.split('/');
        candidate = segments[0];
      }

      if (candidate && !entries.some((e) => e.name === candidate)) {
        entries.push({ name: candidate, type: 'directory' });
      }
    }

    return entries;
  }

  /** readdir() with each entry's lstat (a symlink is listed as one, not as its target). */
  readdirStat(path: string): Array<Dirent & Stat> {
    const abs = this.real(path);
    const vp = this.getProvider(abs);
    if (vp) {
      const p = vp.provider as MountProvider;
      return vp.provider.readdir(vp.subpath).map((d) => {
        const childSubpath = vp.subpath === '/' ? `/${d.name}` : `${vp.subpath}/${d.name}`;
        const s = p.lstat ? p.lstat(childSubpath) : p.stat(childSubpath);
        return { ...d, ...s };
      });
    }

    const node = this.resolveNode(abs);
    if (node.type !== 'directory') {
      throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
    }

    return Array.from(node.children.values()).map((child) => ({ name: child.name, ...VFS.statOfNode(child) }));
  }

  /**
   * Recursively remove a directory and all its contents (a symlink is removed, not followed).
   */
  rmdirRecursive(path: string): void {
    const abs = this.real(path, false);
    const st = this.lstat(abs);
    if (st.type === 'symlink') {
      this.unlink(abs);
      return;
    }
    if (st.type !== 'directory') {
      throw new VFSError(ErrorCode.ENOTDIR, `'${path}': not a directory`);
    }

    // The directory's own entries: readdir() also lists mount points under it, which a recursive
    // delete of the directory mustn't empty.
    const vp = this.getProvider(abs);
    const names = vp ? vp.provider.readdir(vp.subpath).map((d) => d.name) : [...this.resolveNode(abs).children.keys()];
    for (const name of names) {
      const childPath = abs === '/' ? `/${name}` : `${abs}/${name}`;
      if (this.lstat(childPath).type === 'directory') {
        this.rmdirRecursive(childPath);
      } else {
        this.unlink(childPath);
      }
    }
    this.rmdir(abs);
  }
}
