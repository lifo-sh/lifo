/**
 * project/node.ts: JavaScript projects: package.json's scripts first, the framework's defaults
 * where a script is missing (as Vercel and Railpack do).
 *
 *   dev:  scripts.dev, else the framework's dev command, else scripts.start, else `node <entry>`
 *   prod: build = scripts.build, else the framework's build;
 *         start = scripts.start (unless it only starts a dev server), else the framework's
 *         production start, else `node <entry>`
 */

import type { PlanLayer, ProjectReader, ReaderContext } from './plan.js';

interface PackageJson {
	name?: string;
	main?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	engines?: { node?: string };
}

interface Framework {
	name: string;
	/** The dependency that marks it. */
	dep: string;
	dev: string;
	devPort: number;
	build: string | null;
	/** The production start, with `{port}` for the port. */
	start: string | null;
	startPort: number;
	/** A `start` script that runs this only starts a dev server (not fit for production). */
	devServer: RegExp;
}

/** Most specific first: a Next app may also have vite in its dependencies, not the other way round. */
const FRAMEWORKS: Framework[] = [
	{ name: 'next', dep: 'next', dev: 'next dev', devPort: 3000, build: 'next build', start: 'next start -p {port}', startPort: 3000, devServer: /^next(\s+dev\b|\s*$)/ },
	{ name: 'astro', dep: 'astro', dev: 'astro dev', devPort: 4321, build: 'astro build', start: 'astro preview --port {port}', startPort: 4321, devServer: /^astro(\s+dev\b|\s*$)/ },
	{ name: 'expo', dep: 'expo', dev: 'expo start', devPort: 8081, build: null, start: null, startPort: 8081, devServer: /^$/ },
	{ name: 'vite', dep: 'vite', dev: 'vite', devPort: 5173, build: 'vite build', start: 'vite preview --port {port}', startPort: 4173, devServer: /^vite(\s+(dev|serve)\b|\s*$|\s+--)/ },
];

/** Frameworks that build on Vite but serve with their own server: no `vite preview` default for them. */
const VITE_SERVER_FRAMEWORKS = ['@sveltejs/kit', '@react-router/dev', '@remix-run/dev', '@tanstack/react-start', '@tanstack/start', 'nuxt', '@analogjs/platform', 'vike'];

const LOCKFILES: Array<[string, string]> = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lockb', 'bun'],
	['bun.lock', 'bun'],
];

/** The port a command line sets: `--port 3000`, `-p 3000`, `--port=3000`, `PORT=3000 ...`. */
export function portInCommand(cmd: string | undefined | null): number | null {
	if (!cmd) return null;
	const m = /(?:^|\s)(?:--port[=\s]+|-p\s+|PORT=)(\d{2,5})\b/.exec(cmd);
	const n = m ? Number(m[1]) : NaN;
	return n > 0 && n < 65536 ? n : null;
}

function pickFramework(deps: Record<string, string>): Framework | null {
	for (const f of FRAMEWORKS) {
		if (!deps[f.dep]) continue;
		if (f.name === 'vite' && VITE_SERVER_FRAMEWORKS.some((d) => deps[d])) {
			return { ...f, name: VITE_SERVER_FRAMEWORKS.find((d) => deps[d])!, start: null };
		}
		return f;
	}
	return null;
}

function entryOf(ctx: ReaderContext, pkg: PackageJson): string | null {
	const candidates = [pkg.main, 'server.js', 'server.mjs', 'index.js', 'index.mjs', 'app.js', 'main.js'].filter(Boolean) as string[];
	return candidates.find((c) => ctx.exists(c)) ?? null;
}

export const nodeReader: ProjectReader = {
	name: 'node',
	read(ctx) {
		const text = ctx.read('package.json');
		if (text == null) return null;
		let pkg: PackageJson;
		try {
			pkg = JSON.parse(text) || {};
		} catch {
			return { source: 'package.json', needs: [{ name: 'node', from: 'package.json' }], notes: ['package.json is not valid JSON'] };
		}
		const scripts = pkg.scripts || {};
		const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		const fw = pickFramework(deps);
		const notes: string[] = [];
		const layer: PlanLayer = {
			source: 'package.json',
			framework: fw?.name ?? null,
			needs: [{ name: 'node', ...(pkg.engines?.node ? { version: pkg.engines.node } : {}), from: 'package.json' }],
			notes,
		};

		if (Object.keys(deps).length) {
			layer.install = 'npm install';
			layer.installedWhen = 'node_modules';
			const lock = LOCKFILES.find(([f]) => ctx.exists(f));
			if (lock) notes.push(`${lock[0]} found: Lifo installs with npm (from package.json)`);
		}

		const scriptLine = (name: string) => scripts[name]?.trim() || '';
		const entry = entryOf(ctx, pkg);

		if (ctx.mode === 'dev') {
			if (scriptLine('dev')) {
				layer.start = 'npm run dev';
				layer.port = portInCommand(scriptLine('dev')) ?? (fw && fw.devServer.test(scriptLine('dev')) ? fw.devPort : null);
				notes.push('dev command: the "dev" script');
			} else if (fw) {
				layer.start = fw.dev;
				layer.port = fw.devPort;
				notes.push(`dev command: ${fw.name}'s (no "dev" script)`);
			} else if (scriptLine('start')) {
				layer.start = 'npm start';
				layer.port = portInCommand(scriptLine('start'));
				notes.push('dev command: the "start" script (no "dev" script)');
			} else if (entry) {
				layer.start = `node ${entry}`;
				notes.push(`dev command: node ${entry} (no scripts)`);
			}
			if (layer.port == null && fw && layer.start && !scriptLine('dev')) layer.port = fw.devPort;
			return layer;
		}

		// prod
		if (scriptLine('build')) {
			layer.build = ['npm run build'];
			notes.push('build: the "build" script');
		} else if (fw?.build) {
			layer.build = [fw.build];
			notes.push(`build: ${fw.name}'s (no "build" script)`);
		} else layer.build = [];

		const start = scriptLine('start');
		const startIsDevServer = !!(start && fw && fw.devServer.test(start));
		if (start && !startIsDevServer) {
			layer.start = 'npm start';
			layer.port = portInCommand(start) ?? (fw && fw.start && start.startsWith(fw.name) ? fw.startPort : null);
			notes.push('start: the "start" script');
		} else if (fw?.start) {
			layer.port = fw.startPort;
			layer.start = fw.start.replace('{port}', String(fw.startPort));
			notes.push(startIsDevServer ? `start: ${fw.name}'s production server (the "start" script runs a dev server: "${start}")` : `start: ${fw.name}'s production server (no "start" script)`);
		} else if (start) {
			layer.start = 'npm start';
			layer.port = portInCommand(start) ?? fw?.devPort ?? null;
			notes.push(`start: the "start" script (it runs a dev server; ${fw?.name ?? 'this framework'} has no production server in a box yet)`);
		} else if (fw && !fw.start && fw.name === 'expo') {
			layer.start = fw.dev;
			layer.port = fw.devPort;
			notes.push('start: expo start (Expo has no production web build in a box yet)');
		} else if (entry) {
			layer.start = `node ${entry}`;
			notes.push(`start: node ${entry} (no "start" script)`);
		}
		return layer;
	},
};
