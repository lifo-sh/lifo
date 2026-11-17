import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import pkg from './package.json' with { type: 'json' };

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  /^node:/,
];

// LIFO_WATCH=1: `vite build --watch` from the website's linked dev mode (website/scripts/dev.mjs).
const watching = process.env.LIFO_WATCH === '1';

export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.build.json' }),
  ],
  build: {
    // Keep dist/ in place between watch rebuilds, so a consumer never sees it half-empty.
    emptyOutDir: !watching,
    lib: {
      // index: everything. client: the page side of a worker box (WorkerSandbox, box frames,
      // pageAuth), small enough for a page that keeps the box itself in a worker.
      entry: { index: 'src/index.ts', client: 'src/client.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external,
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
