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
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-webgl',
      ],
    },
  },
});
