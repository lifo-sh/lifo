import { describe, it, expect } from 'vitest';
import { createSwcCore } from '../../src/node-compat/swc.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('@swc/core shim', () => {
  it('maps SWC transform options to esbuild and returns { code, map }', async () => {
    let captured: any;
    const mockEsb = {
      transform: async (_code: string, opts: any) => {
        captured = opts;
        return { code: 'OUT', map: 'MAP' };
      },
    };
    const swc = createSwcCore({ vfs: {}, cwd: '/' }, () => mockEsb) as any;
    const res = await swc.transform('source', {
      filename: '/a/App.tsx',
      sourceMaps: true,
      jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic', development: true } } },
    });
    expect(res).toEqual({ code: 'OUT', map: 'MAP' });
    expect(captured.loader).toBe('tsx');
    expect(captured.jsx).toBe('automatic');
    expect(captured.jsxDev).toBe(true);
    expect(captured.sourcemap).toBe(true);
    expect(captured.sourcefile).toBe('/a/App.tsx');
  });

  it('picks loader by extension when parser options are absent', async () => {
    const seen: string[] = [];
    const mockEsb = { transform: async (_c: string, o: any) => { seen.push(o.loader); return { code: '' }; } };
    const swc = createSwcCore({ vfs: {}, cwd: '/' }, () => mockEsb) as any;
    await swc.transform('', { filename: 'x.ts' });
    await swc.transform('', { filename: 'x.jsx' });
    await swc.transform('', { filename: 'x.js' });
    expect(seen).toEqual(['ts', 'jsx', 'jsx']);
  });

  it('transformSync throws (async-only in the VM)', () => {
    const swc = createSwcCore({ vfs: {}, cwd: '/' }, () => ({})) as any;
    expect(() => swc.transformSync()).toThrow(/transformSync/);
  });
});
