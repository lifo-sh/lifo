import { describe, it, expect } from 'vitest';
import { resolveVmTarget } from '../src/vm-routing.js';

/**
 * `resolveVmTarget` decides WHICH in-VM port serves a URL — the difference
 * between an Expo app reaching its tinbase backend and 404ing against Metro.
 *
 * The preview shim inlines this exact function into the iframe (via toString),
 * so testing it here tests what actually runs in the sandboxed document.
 */
const PREVIEW = 8081;
const resolve = (url: unknown, hostPort = '', locationHost = '') =>
  resolveVmTarget(url, PREVIEW, hostPort, locationHost);

describe('resolveVmTarget', () => {
  it('sends a root-absolute path to the preview port', () => {
    expect(resolve('/index.bundle?platform=web')).toEqual({ port: 8081, path: '/index.bundle?platform=web' });
  });

  // The whole point: an unmodified Expo app whose .env says
  // EXPO_PUBLIC_SUPABASE_URL=/_sw/54321 must reach tinbase, not Metro.
  it('routes the /_sw/<port>/ form to that port and strips the prefix', () => {
    expect(resolve('/_sw/54321/rest/v1/todos?select=*')).toEqual({
      port: 54321,
      path: '/rest/v1/todos?select=*',
    });
  });

  it('routes the /_sw/<boxId>/<port>/ form too', () => {
    expect(resolve('/_sw/box_ab12cd34/54321/rest/v1/todos')).toEqual({ port: 54321, path: '/rest/v1/todos' });
  });

  it('treats /_sw/<port> with no trailing path as that port’s root', () => {
    expect(resolve('/_sw/54321')).toEqual({ port: 54321, path: '/' });
  });

  it('routes an absolute loopback URL to its own port', () => {
    expect(resolve('http://localhost:54321/rest/v1/todos')).toEqual({ port: 54321, path: '/rest/v1/todos' });
    expect(resolve('http://127.0.0.1:54321/auth/v1/token')).toEqual({ port: 54321, path: '/auth/v1/token' });
  });

  it('keeps the preview port for a loopback URL with no explicit port', () => {
    expect(resolve('http://localhost/assets/font.ttf')).toEqual({ port: 8081, path: '/assets/font.ttf' });
  });

  it('resolves a relative URL against the preview origin', () => {
    expect(resolve('./chunk.js')).toEqual({ port: 8081, path: '/chunk.js' });
  });

  it('honours the SW prefix inside an absolute URL', () => {
    expect(resolve('http://localhost:8081/_sw/54321/rest/v1/todos?x=1')).toEqual({
      port: 54321,
      path: '/rest/v1/todos?x=1',
    });
  });

  it('does not tunnel blob:, data: or a foreign origin', () => {
    expect(resolve('blob:http://localhost:5173/9f8c')).toBeNull();
    expect(resolve('data:text/plain,hi')).toBeNull();
    expect(resolve('https://esm.reactnative.run/react')).toBeNull();
    expect(resolve('https://registry.npmjs.org/express')).toBeNull();
  });

  it('does not tunnel an empty or missing URL', () => {
    expect(resolve('')).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve(null)).toBeNull();
  });

  // Regression: the embedding page is on loopback too during local dev, so a
  // naive "loopback ⇒ in-VM" rule sent requests for the playground's own origin
  // (and its /_cors proxy) to a non-existent in-VM port 5173.
  it('does not tunnel the embedding page’s own origin', () => {
    expect(resolve('http://localhost:5173/assets/x.png', '5173')).toBeNull();
    expect(resolve('http://localhost:5173/_cors?url=https://x.dev/y', '5173')).toBeNull();
    // …while a genuine sibling service on another loopback port still routes.
    expect(resolve('http://localhost:54321/rest/v1/todos', '5173')).toEqual({
      port: 54321,
      path: '/rest/v1/todos',
    });
  });

  // Regression: this is the URL an Expo app actually requests. React Native
  // needs absolute URLs, so the app resolves its configured `/_sw/54321` against
  // location.origin — which inside a blob document is the EMBEDDER's origin. The
  // embedder-port exclusion used to run first, so this fell through to the real
  // network and a registered service worker answered it: the SW-free preview
  // was quietly depending on a service worker.
  it('tunnels an embedder-origin URL that carries a /_sw/<port>/ prefix', () => {
    expect(resolve('http://localhost:5173/_sw/54321/rest/v1/todos?select=*', '5173')).toEqual({
      port: 54321,
      path: '/rest/v1/todos?select=*',
    });
    // …while the same origin WITHOUT the prefix still goes to the real network.
    expect(resolve('http://localhost:5173/_cors?url=https://x.dev', '5173')).toBeNull();
    expect(resolve('http://localhost:5173/assets/x.png', '5173')).toBeNull();
  });

  it('honours the boxId form on the embedder origin too', () => {
    expect(resolve('http://localhost:5173/_sw/box_ab12/54321/auth/v1/token', '5173')).toEqual({
      port: 54321,
      path: '/auth/v1/token',
    });
  });

  it('never tunnels a foreign origin, even with a /_sw/ path', () => {
    expect(resolve('https://evil.example.com/_sw/54321/rest/v1/todos', '5173')).toBeNull();
  });

  it('tunnels a same-origin non-loopback URL to the preview port', () => {
    expect(resolve('https://preview.example.dev/assets/x.png', '', 'preview.example.dev')).toEqual({
      port: 8081,
      path: '/assets/x.png',
    });
  });
});
