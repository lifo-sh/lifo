import { describe, it, expect } from 'vitest';
import { VirtualFS } from 'browser-metro';
import { upsertExternalAsset } from '../../src/commands/system/browser-metro.js';

/**
 * The bundler only resolves a require() to a path that `exists()` in ITS VFS
 * (walkDeps skips anything else), and only emits the `{ uri }` stub an <Image>
 * needs when that entry is marked external. readFileMap seeds both at startup;
 * this helper is what the watch loop uses for assets that arrive later.
 *
 * Regression pinned here: a chat-attached image uploaded mid-session was
 * written to the kernel VFS but dropped from the bundler's change list, so the
 * agent's `require('../../assets/avatar.jpeg')` crashed the preview with
 * "Module not found: /assets/avatar.jpeg" until the sandbox was recreated.
 */
describe('upsertExternalAsset — assets written after startup', () => {
  it('registers a new asset as an external entry the bundler can resolve', () => {
    const bvfs = new VirtualFS({ '/index.tsx': { content: 'export {}', isExternal: false } });
    expect(bvfs.exists('/assets/avatar.jpeg')).toBe(false);

    const type = upsertExternalAsset(bvfs, '/assets/avatar.jpeg');

    expect(type).toBe('create');
    expect(bvfs.exists('/assets/avatar.jpeg')).toBe(true);
    expect(bvfs.isExternalAsset('/assets/avatar.jpeg')).toBe(true);
    // Binary bytes must never be decoded into the bundler's text map.
    expect(bvfs.read('/assets/avatar.jpeg')).toBe('');
  });

  it('reports a re-written asset as an update and keeps it external', () => {
    const bvfs = new VirtualFS({ '/assets/logo.png': { content: '', isExternal: true } });

    expect(upsertExternalAsset(bvfs, '/assets/logo.png')).toBe('update');
    expect(bvfs.isExternalAsset('/assets/logo.png')).toBe(true);
  });

  it('leaves every other entry untouched', () => {
    const bvfs = new VirtualFS({
      '/index.tsx': { content: 'export {}', isExternal: false },
      '/assets/icon.png': { content: '', isExternal: true },
    });

    upsertExternalAsset(bvfs, '/assets/avatar.jpeg');

    expect(bvfs.read('/index.tsx')).toBe('export {}');
    expect(bvfs.isExternalAsset('/index.tsx')).toBe(false);
    expect(bvfs.isExternalAsset('/assets/icon.png')).toBe(true);
    expect(bvfs.list().sort()).toEqual(['/assets/avatar.jpeg', '/assets/icon.png', '/index.tsx']);
  });

  it('is what VirtualFS.write() cannot do — a plain write is not external', () => {
    // Documents WHY the helper exists: write() would make the bundler emit a
    // bare-filename stub instead of the `{ uri }` an <Image source> needs.
    const bvfs = new VirtualFS({});
    bvfs.write('/assets/plain.png', '');
    expect(bvfs.isExternalAsset('/assets/plain.png')).toBe(false);
  });
});
