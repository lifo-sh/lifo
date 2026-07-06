import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.json' }),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        '@lifo-sh/core',
        // Externalize all @wterm/* (incl. the /css subpath) — the consumer's
        // bundler resolves them. wterm's WASM core is inlined, so no assets.
        /^@wterm\//,
      ],
    },
  },
});
