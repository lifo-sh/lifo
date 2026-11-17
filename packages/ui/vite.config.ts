import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// LIFO_WATCH=1: `vite build --watch` from the website's linked dev mode (website/scripts/dev.mjs).
const watching = process.env.LIFO_WATCH === '1';

export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.json' }),
  ],
  build: {
    // Keep dist/ in place between watch rebuilds, so a consumer never sees it half-empty.
    emptyOutDir: !watching,
    lib: {
      // `preview-nosw` is a second entry so the SW-free transport can be
      // imported on its own. The main entry pulls in the xterm-backed Terminal,
      // which needs a DOM — importing it from Node (benches, headless tests)
      // fails on the xterm import alone.
      entry: {
        index: 'src/index.ts',
        'preview-nosw': 'src/preview-nosw.ts',
        // Standalone so another embedder can take just the shims / routing
        // rules without the DOM-bound preview mount or xterm.
        'preview-shims': 'src/preview-shims.ts',
        'vm-routing': 'src/vm-routing.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: [
        '@lifo-sh/core',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-webgl',
      ],
    },
  },
});
