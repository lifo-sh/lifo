/**
 * `rimraf` npm package shim for Lifo.
 *
 * Provides the rimraf(path, [opts], cb) callback API, rimraf.sync(path),
 * and the modern rimraf v4+ promise-based API, all backed by the VFS
 * fs shim's recursive rmdir.
 */

import type { VFS } from '../kernel/vfs/index.js';
import { resolve } from './path.js';

export interface RimrafOptions {
  glob?: boolean | object;
  maxRetries?: number;
  retryDelay?: number;
  filter?: (path: string) => boolean;
}

export function createRimraf(vfs: VFS, cwd: string) {
  function removeSync(p: string): void {
    const abs = resolve(cwd, p);
    if (!vfs.exists(abs)) return;

    const stat = vfs.stat(abs);
    if (stat.type === 'directory') {
      vfs.rmdirRecursive(abs);
    } else {
      vfs.unlink(abs);
    }
  }

  function removeAsync(p: string): Promise<void> {
    return new Promise((res, rej) => {
      try {
        removeSync(p);
        res();
      } catch (e) {
        rej(e);
      }
    });
  }

  // rimraf(path, [opts], cb) — classic callback API (rimraf v3)
  function rimraf(p: string, optsOrCb?: RimrafOptions | ((err: Error | null) => void), cb?: (err: Error | null) => void): void {
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    try {
      removeSync(p);
      callback?.(null);
    } catch (e) {
      callback?.(e as Error);
    }
  }

  // rimraf.sync / rimrafSync
  rimraf.sync = removeSync;

  // Modern rimraf v4+ returns a promise
  rimraf.rimraf = removeAsync;
  rimraf.rimrafSync = removeSync;

  // Native implementations (same thing in our shim)
  rimraf.native = removeAsync;
  rimraf.nativeSync = removeSync;

  // Manual implementations (same thing in our shim)
  rimraf.manual = removeAsync;
  rimraf.manualSync = removeSync;

  // Windows implementations (same thing in our shim)
  rimraf.windows = removeAsync;
  rimraf.windowsSync = removeSync;

  // moveRemove implementations (same thing in our shim)
  rimraf.moveRemove = removeAsync;
  rimraf.moveRemoveSync = removeSync;

  rimraf.default = rimraf;

  return rimraf;
}
