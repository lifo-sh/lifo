import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { portBridgePlugin } from './src/vite-plugin-port-bridge';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/playground/' : '/',
  plugins: [tailwindcss(), portBridgePlugin()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@lifo-sh/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@lifo-sh/ui': path.resolve(__dirname, '../../packages/ui/src/index.ts'),
      'lifo-pkg-git': path.resolve(__dirname, '../../packages/lifo-pkg-git/src/index.ts'),
      'lifo-pkg-ffmpeg': path.resolve(__dirname, '../../packages/lifo-pkg-ffmpeg/src/index.ts'),
    },
  },
}));
