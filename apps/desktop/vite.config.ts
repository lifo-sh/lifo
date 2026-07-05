import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig(({ command }) => ({
	base: command === 'build' ? '/desktop/' : '/',
	server: {
		port: 3001,
	},
	resolve: {
		alias: {
			'@lifo-sh/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
		},
	},
}));
