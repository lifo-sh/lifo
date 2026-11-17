import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.build.json' })],
  build: {
    lib: { entry: { index: 'src/index.ts', pip: 'src/pip.ts' }, formats: ['es'] },
    // pyodide is loaded at run time (the npm package in Node, the CDN in a browser), never bundled.
    rollupOptions: { external: ['@lifo-sh/core', 'pyodide'] },
  },
  test: { globals: true, environment: 'node', testTimeout: 120_000, hookTimeout: 120_000 },
});
