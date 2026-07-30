import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.build.json' })],
  build: {
    // Three entries, one package: the pure API, the host bin, and the in-box
    // command. Only `lifo` may touch @lifo-sh/core and only `cli` may touch
    // node builtins — separate chunks are what let one npm package work in both
    // places without either dependency being required in the other.
    lib: {
      entry: { index: 'src/index.ts', cli: 'src/cli.ts', lifo: 'src/lifo.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^node:/, '@lifo-sh/core'],
      output: {
        entryFileNames: '[name].js',
        // The bin needs a shebang; the library entries must not have one.
        banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : ''),
      },
    },
  },
  test: { globals: true, environment: 'node' },
});
