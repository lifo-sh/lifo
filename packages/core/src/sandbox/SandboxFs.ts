import type { VFS } from '../kernel/vfs/index.js';
import type { SandboxFs as ISandboxFs } from './types.js';
import { resolve, dirname } from '../utils/path.js';
import { createTar, parseTar, compressGzip, decompressGzip } from '../utils/archive.js';
import type { TarEntry } from '../utils/archive.js';
import { isExcluded } from '../kernel/vfs/sync.js';
import type { SnapshotOptions } from './types.js';

/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export class SandboxFsImpl implements ISandboxFs {
  constructor(
    private vfs: VFS,
    private getCwd: () => string,
  ) {}

  private resolvePath(path: string): string {
    return resolve(this.getCwd(), path);
  }

  readFile(path: string): Promise<string>;
  readFile(path: string, encoding: null): Promise<Uint8Array>;
  readFile(path: string, encoding?: null): Promise<string | Uint8Array> {
    const abs = this.resolvePath(path);
    if (encoding === null) {
      return Promise.resolve(this.vfs.readFile(abs));
    }
    return Promise.resolve(this.vfs.readFileString(abs));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const abs = this.resolvePath(path);
    this.vfs.writeFile(abs, content);
  }

  async readdir(path: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
    const abs = this.resolvePath(path);
    return this.vfs.readdir(abs);
  }

  async stat(path: string): Promise<{ type: 'file' | 'directory'; size: number; mtime: number }> {
    const abs = this.resolvePath(path);
    const s = this.vfs.stat(abs);
    return { type: s.type, size: s.size, mtime: s.mtime };
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    this.vfs.mkdir(abs, options);
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    const abs = this.resolvePath(path);
    const s = this.vfs.stat(abs);
    if (s.type === 'directory') {
      if (options?.recursive) {
        this.vfs.rmdirRecursive(abs);
      } else {
        this.vfs.rmdir(abs);
      }
    } else {
      this.vfs.unlink(abs);
    }
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.resolvePath(path);
    return this.vfs.exists(abs);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const absOld = this.resolvePath(oldPath);
    const absNew = this.resolvePath(newPath);
    this.vfs.rename(absOld, absNew);
  }

  async cp(src: string, dest: string): Promise<void> {
    const absSrc = this.resolvePath(src);
    const absDest = this.resolvePath(dest);
    this.vfs.copyFile(absSrc, absDest);
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void> {
    for (const { path, content } of files) {
      await this.writeFile(path, content);
    }
  }

  /** Directories to skip during export (virtual providers) */
  private static SKIP_DIRS = new Set(['/proc', '/dev']);

  async exportSnapshot(options: SnapshotOptions = {}): Promise<Uint8Array> {
    const entries: TarEntry[] = [];

    const walk = (absPath: string): void => {
      if (SandboxFsImpl.SKIP_DIRS.has(absPath)) return;
      if (isExcluded(absPath, options.exclude)) return;

      const stat = this.vfs.stat(absPath);

      if (stat.type === 'directory') {
        // Add directory entry (skip root itself)
        if (absPath !== '/') {
          entries.push({
            path: absPath,
            data: new Uint8Array(0),
            type: 'directory',
            mode: stat.mode,
            mtime: stat.mtime,
          });
        }

        const children = this.vfs.readdir(absPath);
        for (const child of children) {
          const childPath = absPath === '/' ? `/${child.name}` : `${absPath}/${child.name}`;
          walk(childPath);
        }
      } else {
        entries.push({
          path: absPath,
          data: this.vfs.readFile(absPath),
          type: 'file',
          mode: stat.mode,
          mtime: stat.mtime,
        });
      }
    };

    walk('/');

    const tar = createTar(entries);
    return compressGzip(tar);
  }

  async importSnapshot(data: Uint8Array): Promise<void> {
    const tar = await decompressGzip(data);
    const entries = parseTar(tar);

    // Process directories first, then files, to ensure parents exist
    const dirs = entries.filter((e) => e.type === 'directory');
    const files = entries.filter((e) => e.type === 'file');

    for (const entry of dirs) {
      const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
      if (!this.vfs.exists(path)) {
        this.vfs.mkdir(path, { recursive: true });
      }
    }

    for (const entry of files) {
      const path = entry.path.startsWith('/') ? entry.path : '/' + entry.path;
      // Ensure parent directory exists
      const parent = dirname(path);
      if (parent !== '/' && !this.vfs.exists(parent)) {
        this.vfs.mkdir(parent, { recursive: true });
      }
      // Defensive: never write a file over an existing directory (a restore
      // must not throw mid-way and leave the tree half-populated).
      if (this.vfs.exists(path) && this.vfs.stat(path).type === 'directory') continue;
      this.vfs.writeFile(path, entry.data);
    }
  }
}
