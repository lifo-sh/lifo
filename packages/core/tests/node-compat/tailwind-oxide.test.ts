import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createOxideScanner } from '../../src/node-compat/tailwind-oxide.js';

describe('tailwind oxide Scanner shim', () => {
  it('extracts class candidates and skips node_modules / build dirs', () => {
    const vfs = new VFS();
    vfs.mkdir('/app/src', { recursive: true });
    vfs.writeFile(
      '/app/src/App.tsx',
      'export default () => <div className="flex items-center bg-[#fff] hover:bg-red-500 text-sm/6" />',
    );
    vfs.mkdir('/app/node_modules/foo', { recursive: true });
    vfs.writeFile('/app/node_modules/foo/index.js', 'const x = "should-not-appear-nm"');
    vfs.mkdir('/app/dist', { recursive: true });
    vfs.writeFile('/app/dist/bundle.js', 'const y = "should-not-appear-dist"');

    const Scanner = createOxideScanner(vfs);
    const s = new Scanner({ sources: [{ base: '/app', pattern: '**/*', negated: false }] });
    const cands = s.scan();

    expect(cands).toContain('flex');
    expect(cands).toContain('items-center');
    expect(cands).toContain('bg-[#fff]');
    expect(cands).toContain('hover:bg-red-500');
    expect(cands).toContain('text-sm/6');
    expect(cands).not.toContain('should-not-appear-nm');
    expect(cands).not.toContain('should-not-appear-dist');

    // files/globs getters (used by @tailwindcss/vite for watch)
    expect(s.files.some((f) => f.endsWith('/App.tsx'))).toBe(true);
    expect(s.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(s.globs).toEqual([{ base: '/app', pattern: '**/*' }]);
  });

  it('scanFiles extracts candidates from provided content (arbitrary values with parens)', () => {
    const vfs = new VFS();
    const Scanner = createOxideScanner(vfs);
    const s = new Scanner({ sources: [] });
    const cands = s.scanFiles([
      { content: '<a class="p-4 grid-cols-[repeat(2,1fr)] -mt-2">', extension: 'html' },
    ]);
    expect(cands).toContain('p-4');
    expect(cands).toContain('grid-cols-[repeat(2,1fr)]');
    expect(cands).toContain('-mt-2');
  });

  it('getCandidatesWithPositions returns positions', () => {
    const vfs = new VFS();
    const Scanner = createOxideScanner(vfs);
    const s = new Scanner({ sources: [] });
    const out = s.getCandidatesWithPositions({ content: 'flex p-2', extension: 'html' });
    expect(out[0]).toEqual({ candidate: 'flex', position: 0 });
    expect(out.find((c) => c.candidate === 'p-2')?.position).toBe(5);
  });
});
