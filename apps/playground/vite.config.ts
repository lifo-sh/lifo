import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { portBridgePlugin } from './src/vite-plugin-port-bridge';
import { corsProxyPlugin } from './src/vite-plugin-cors-proxy';
import { browsePlugin } from './src/vite-plugin-browse';
import { firefoxPlugin } from './src/vite-plugin-firefox';

// LIFO_EMBED=1: served by the lifo.sh website's dev server, which proxies /playground/*
// here (website/scripts/dev.mjs), so edits show up on the site live. Same base as the
// production copy, its own port (5273) so it can run next to a standalone `pnpm dev`, and
// HMR talks to this server directly, since the proxy doesn't carry it.
const embedded = process.env.LIFO_EMBED === '1';

export default defineConfig(({ command }) => ({
  base: command === 'build' || embedded ? '/playground/' : '/',
  plugins: [react(), tailwindcss(), portBridgePlugin(), corsProxyPlugin(), browsePlugin(), firefoxPlugin()],
  server: {
    port: embedded ? 5273 : 5173,
    ...(embedded && {
      strictPort: true,
      hmr: { clientPort: 5273 },
      headers: { 'Service-Worker-Allowed': '/_sw/' },
    }),
    // Pre-transform the entry + example modules at startup so the first time you
    // open an example it isn't a cold on-demand transform stall. Dev only.
    warmup: {
      clientFiles: ['./src/main.tsx', './src/components/app-shell.tsx', './src/examples/*.tsx'],
    },
  },
  // Lock the heavy browser deps into the pre-bundle so Vite never discovers one
  // mid-session and triggers a full-page reload to re-optimize.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'monaco-editor',
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-webgl',
      'isomorphic-git',
    ],
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
      // A directory, so lifo-pkg-agent/worker and /browser resolve to src/worker.ts and src/browser.ts.
      'lifo-pkg-agent': path.resolve(__dirname, '../../packages/lifo-pkg-agent/src'),
      'lifo-pkg-ffmpeg': path.resolve(__dirname, '../../packages/lifo-pkg-ffmpeg/src/index.ts'),
    },
  },
}));
