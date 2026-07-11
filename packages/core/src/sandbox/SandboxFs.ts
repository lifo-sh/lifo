import type { VFS } from '../kernel/vfs/index.js';
import type { SandboxFs as ISandboxFs } from './types.js';
import { resolve } from '../utils/path.js';
import { exportVfsSnapshot, importVfsSnapshot } from '../kernel/vfs/snapshot.js';
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
  async exportSnapshot(options: SnapshotOptions = {}): Promise<Uint8Array> {
    return exportVfsSnapshot(this.vfs, options);
  }

  async importSnapshot(data: Uint8Array): Promise<void> {
    return importVfsSnapshot(this.vfs, data);
  }
}
