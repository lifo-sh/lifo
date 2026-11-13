import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// Six entries: the agent (default command), the browser command, the WebLLM worker module, the
// Node proxy, the Firefox backend and the Chromium backend. Shared code lands in chunks.
export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.build.json' })],
  build: {
    target: 'es2022',
    lib: {
      entry: {
        index: 'src/index.ts',
        browser: 'src/browser.ts',
        worker: 'src/worker.ts',
        proxy: 'src/proxy.ts',
        firefox: 'src/firefox/index.ts',
        chromium: 'src/chromium/index.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@lifo-sh/core', '@mlc-ai/web-llm', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
    emptyOutDir: process.env.LIFO_WATCH !== '1',
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
