import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: false,
    clean: true,
    target: 'node18',
    external: ['@lifo-sh/core'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  {
    entry: ['src/session.ts', 'src/daemon.ts', 'src/auth.ts'],
    format: ['esm'],
    dts: false,
    target: 'node18',
    external: ['@lifo-sh/core'],
  },
]);
