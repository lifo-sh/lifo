import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { portBridgePlugin } from './src/vite-plugin-port-bridge';
import { corsProxyPlugin } from './src/vite-plugin-cors-proxy';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/playground/' : '/',
  plugins: [react(), tailwindcss(), portBridgePlugin(), corsProxyPlugin()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // Split the big, stable vendors into their own long-lived chunks.
        // (Monaco is left alone — it's already dynamically imported and manual
        // chunking it breaks its worker resolution.)
        manualChunks(id: string) {
          if (id.includes('node_modules/@xterm')) return 'xterm';
          if (
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'react-vendor';
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@lifo-sh/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@lifo-sh/ui': path.resolve(__dirname, '../../packages/ui/src/index.ts'),
      'lifo-pkg-git': path.resolve(__dirname, '../../packages/lifo-pkg-git/src/index.ts'),
      'lifo-pkg-ffmpeg': path.resolve(__dirname, '../../packages/lifo-pkg-ffmpeg/src/index.ts'),
    },
  },
}));
