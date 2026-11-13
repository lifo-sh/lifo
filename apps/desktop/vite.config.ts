import { defineConfig } from 'vite';
import path from 'path';

// LIFO_EMBED=1: served by the lifo.sh website's dev server under /desktop/ (see
// apps/playground/vite.config.ts), on port 5274.
const embedded = process.env.LIFO_EMBED === '1';

export default defineConfig(({ command }) => ({
	base: command === 'build' || embedded ? '/desktop/' : '/',
	server: {
		port: embedded ? 5274 : 3001,
		...(embedded && { strictPort: true, hmr: { clientPort: 5274 } }),
	},
	resolve: {
		alias: {
			'@lifo-sh/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
		},
	},
}));
