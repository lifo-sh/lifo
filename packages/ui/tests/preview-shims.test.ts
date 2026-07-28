import { describe, it, expect } from 'vitest';
import { buildPreviewShim, ALL_SHIMS } from '../src/preview-shims.js';
import { shimScript } from '../src/preview-nosw.js';
import { resolveVmTarget } from '../src/vm-routing.js';

/**
 * The shim is source text injected into a preview document, so what's checkable
 * here is composition: that each patch is opt-in, that the inlined router is the
 * real function, and that the result parses as JavaScript.
 */
function parses(src: string): boolean {
  try {
    new Function(src);
    return true;
  } catch {
    return false;
  }
}

describe('buildPreviewShim', () => {
  it('produces valid JavaScript with every patch', () => {
    const src = buildPreviewShim({ port: 8081, hostOrigin: 'http://localhost:5173' });
    expect(parses(src)).toBe(true);
    expect(src).toContain('window.fetch=');
    expect(src).toContain('window.XMLHttpRequest=');
    expect(src).toContain('window.WebSocket=');
  });

  it('installs only the requested patches', () => {
    const src = buildPreviewShim({ port: 3000, include: ['fetch'] });
    expect(parses(src)).toBe(true);
    expect(src).toContain('window.fetch=');
    expect(src).not.toContain('window.XMLHttpRequest=');
    expect(src).not.toContain('window.WebSocket=');
    expect(src).not.toContain('HTMLImageElement');
  });

  it('supports HTTP-only embedding (fetch + xhr, no ws or assets)', () => {
    const src = buildPreviewShim({ port: 3000, include: ['fetch', 'xhr'] });
    expect(parses(src)).toBe(true);
    expect(src).toContain('window.XMLHttpRequest=');
    expect(src).not.toContain('window.WebSocket=');
  });

  // Regression: the inlined router referenced a module-level `SW_PREFIX`
  // constant, which becomes an undefined free variable inside the iframe — the
  // routing would have thrown on the first request. Nothing in the stringified
  // function may reference anything outside its own body, so evaluate it in
  // isolation (no module scope) and actually call it.
  it('inlines a SELF-CONTAINED resolveVmTarget (no free variables)', () => {
    const isolated = new Function(`return (${resolveVmTarget.toString()});`)() as typeof resolveVmTarget;
    expect(isolated('/_sw/54321/rest/v1/todos', 8081, '', '')).toEqual({
      port: 54321,
      path: '/rest/v1/todos',
    });
    expect(isolated('/index.bundle', 8081, '', '')).toEqual({ port: 8081, path: '/index.bundle' });
    expect(isolated('https://esm.reactnative.run/react', 8081, '', '')).toBeNull();
  });

  it('inlines the real function, not a hand-copied duplicate', () => {
    const src = buildPreviewShim({ port: 8081 });
    expect(src).toContain(resolveVmTarget.toString());
  });

  it('bakes in the preview port and the embedder origin', () => {
    // The embedder origin must be baked in by the parent: a blob: document
    // reports location.host as the empty string, so it cannot be read inside.
    const src = buildPreviewShim({ port: 8081, hostOrigin: 'https://lifo.sh' });
    expect(src).toContain('var PORT=8081');
    expect(src).toContain('HOST_ORIGIN="https://lifo.sh"');
  });

  // The asset patches call window.fetch, so shipping them without the fetch
  // patch would silently send them to the real network.
  it('refuses asset patches without the fetch patch', () => {
    expect(() => buildPreviewShim({ port: 8081, include: ['images'] })).toThrow(/must be included/);
    expect(() => buildPreviewShim({ port: 8081, include: ['fonts', 'css'] })).toThrow(/must be included/);
  });

  it('rejects an unsupported transport', () => {
    // @ts-expect-error deliberately invalid
    expect(() => buildPreviewShim({ port: 8081, transport: 'MessagePort' })).toThrow(/unsupported transport/);
  });

  it('ALL_SHIMS is what the default build includes', () => {
    expect(buildPreviewShim({ port: 1 })).toBe(buildPreviewShim({ port: 1, include: ALL_SHIMS }));
  });

  it('shimScript stays a thin wrapper (back-compat)', () => {
    expect(shimScript(8081, 'http://localhost:5173')).toBe(buildPreviewShim({ port: 8081, hostOrigin: 'http://localhost:5173' }));
  });
});
