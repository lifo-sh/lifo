/**
 * project/plan.ts: what a project needs to run, the same answer wherever Lifo runs.
 *
 * A browser tab, `lifo-sh` on a laptop and a Lifo Cloud box (workerd or container) all read a
 * project the same way: `resolvePlan()` turns its files into a plan (install, build, start, port,
 * env, and the toolchains it needs). Each place then compares `needs` with what it has and either
 * runs the plan (`lifo dev`, `lifo build`, `lifo start`, `lifo cloud push`) or says where it can run.
 *
 * Two modes, like Next.js on a laptop and on Vercel:
 *   dev   install, then the dev command (a dev server with live reload). The default in a box.
 *   prod  install, then the build, then the production start. The default for Lifo Cloud.
 *
 * Where the answer comes from, each layer over the one before:
 *   1. language readers (`node` today: package.json and its framework; Go, Rust, Python later,
 *      through `registerProjectReader`);
 *   2. the Dockerfile, read as a recipe rather than an image (project/dockerfile.ts);
 *   3. lifo.json, which can set any field.
 *
 * Pure: it reads files through `ProjectFiles`, so it runs on a VFS, on disk or on a snapshot.
 */

export type ProjectMode = 'dev' | 'prod';

/** How a reader sees the project's files. Paths are absolute. */
export interface ProjectFiles {
	read(path: string): string | null;
	exists(path: string): boolean;
}

/** A toolchain the project needs, and what said so. */
export interface ProjectNeed {
	/** `node`, `python`, `go`, `rust`, ... (see NEED_COMMANDS) */
	name: string;
	/** As the project asked for it (`20`, `>=18`, `1.23-alpine`), when it said. */
	version?: string;
	/** What asked for it: `package.json`, `FROM golang:1.23 (Dockerfile)`. */
	from: string;
}

export interface ProjectPlan {
	/** The project's directory. */
	dir: string;
	mode: ProjectMode;
	/** Files the plan was read from, in the order they were applied (the last one wins). */
	sources: string[];
	/** The framework a reader recognised (`next`, `vite`, `astro`, `expo`), if any. */
	framework: string | null;
	/** Installs dependencies (`npm install`); null when there's nothing to install. */
	install: string | null;
	/** A path, relative to `dir`, that exists once `install` has run: `lifo dev` skips it then. */
	installedWhen: string | null;
	/** Build steps, in order (prod; a dev plan has none unless nothing else can start it). */
	build: string[];
	/** Environment for the build steps only (a Dockerfile's builder stages). */
	buildEnv: Record<string, string>;
	/** Starts the app: the dev command in dev, the production start in prod. */
	start: string | null;
	/** The port the app listens on, when known. */
	port: number | null;
	/** Environment for the start command. */
	env: Record<string, string>;
	needs: ProjectNeed[];
	/** What the plan leaves out, and why (a Dockerfile's `apt-get install`, `USER`, ...). */
	skipped: Array<{ what: string; why: string }>;
	/** How each part was decided, for `lifo plan`. */
	notes: string[];
}

/** One reader's part of a plan. Fields left undefined keep what earlier layers said. */
export interface PlanLayer {
	source: string;
	framework?: string | null;
	install?: string | null;
	installedWhen?: string | null;
	build?: string[];
	buildEnv?: Record<string, string>;
	start?: string | null;
	port?: number | null;
	env?: Record<string, string>;
	needs?: ProjectNeed[];
	skipped?: Array<{ what: string; why: string }>;
	notes?: string[];
}

export interface ReaderContext {
	files: ProjectFiles;
	dir: string;
	mode: ProjectMode;
	/** Joins `dir` and a relative path. */
	path(rel: string): string;
	/** The file's text, or null. */
	read(rel: string): string | null;
	exists(rel: string): boolean;
	/** The plan so far (earlier layers), for readers that build on it. */
	sofar: ProjectPlan;
}

/** Reads one kind of project. Returns null when the project isn't that kind. */
export interface ProjectReader {
	name: string;
	read(ctx: ReaderContext): PlanLayer | null;
}

const languageReaders: ProjectReader[] = [];

/**
 * Add a language reader (Go, Rust, Python, ...). Language readers run first, in the order they
 * were registered; the Dockerfile and lifo.json are applied over them.
 */
export function registerProjectReader(reader: ProjectReader): void {
	const i = languageReaders.findIndex((r) => r.name === reader.name);
	if (i >= 0) languageReaders[i] = reader;
	else languageReaders.push(reader);
}

export function projectReaders(): readonly ProjectReader[] {
	return languageReaders;
}

export function emptyPlan(dir: string, mode: ProjectMode): ProjectPlan {
	return {
		dir,
		mode,
		sources: [],
		framework: null,
		install: null,
		installedWhen: null,
		build: [],
		buildEnv: {},
		start: null,
		port: null,
		env: {},
		needs: [],
		skipped: [],
		notes: [],
	};
}

export function applyLayer(plan: ProjectPlan, layer: PlanLayer): ProjectPlan {
	const out: ProjectPlan = { ...plan, sources: [...plan.sources, layer.source] };
	if (layer.framework !== undefined) out.framework = layer.framework;
	if (layer.install !== undefined) out.install = layer.install;
	if (layer.installedWhen !== undefined) out.installedWhen = layer.installedWhen;
	if (layer.build !== undefined) out.build = [...layer.build];
	if (layer.buildEnv) out.buildEnv = { ...plan.buildEnv, ...layer.buildEnv };
	if (layer.start !== undefined) out.start = layer.start;
	if (layer.port !== undefined) out.port = layer.port;
	if (layer.env) out.env = { ...plan.env, ...layer.env };
	if (layer.needs) {
		const needs = [...plan.needs];
		for (const n of layer.needs) {
			const i = needs.findIndex((x) => x.name === n.name);
			if (i < 0) needs.push(n);
			else if (n.version && !needs[i].version) needs[i] = n;
		}
		out.needs = needs;
	}
	if (layer.skipped) out.skipped = [...plan.skipped, ...layer.skipped];
	if (layer.notes) out.notes = [...plan.notes, ...layer.notes];
	return out;
}

export function joinPath(dir: string, rel: string): string {
	if (rel.startsWith('/')) return rel;
	const base = dir.replace(/\/+$/, '');
	const parts = (base ? base.split('/') : ['']).concat(rel.split('/'));
	const out: string[] = [];
	for (const p of parts) {
		if (p === '' && out.length) continue;
		if (p === '.') continue;
		if (p === '..') {
			if (out.length > 1) out.pop();
			continue;
		}
		out.push(p);
	}
	return out.join('/') || '/';
}

function readerContext(files: ProjectFiles, dir: string, mode: ProjectMode, sofar: ProjectPlan): ReaderContext {
	const path = (rel: string) => joinPath(dir, rel);
	return {
		files,
		dir,
		mode,
		path,
		read: (rel) => {
			try {
				return files.read(path(rel));
			} catch {
				return null;
			}
		},
		exists: (rel) => {
			try {
				return files.exists(path(rel));
			} catch {
				return false;
			}
		},
		sofar,
	};
}

/** lifo.json fields that shape the plan. `runtime` is Lifo Cloud's (see docs/cloud/boxes.md). */
export interface LifoJson {
	install?: string | null;
	build?: string | string[] | null;
	/** The production start. */
	start?: string | null;
	/** The dev command. */
	dev?: string | null;
	port?: number | null;
	env?: Record<string, string>;
	runtime?: 'auto' | 'workerd' | 'container';
}

/** lifo.json, over everything else: any field it sets wins. */
export const lifoJsonReader: ProjectReader = {
	name: 'lifo.json',
	read(ctx) {
		const text = ctx.read('lifo.json');
		if (text == null) return null;
		let j: LifoJson;
		try {
			j = JSON.parse(text);
		} catch {
			return { source: 'lifo.json', notes: ['lifo.json is not valid JSON: ignored'] };
		}
		if (!j || typeof j !== 'object') return null;
		const layer: PlanLayer = { source: 'lifo.json', notes: [] };
		const set = (what: string) => layer.notes!.push(`${what} from lifo.json`);
		if (j.install !== undefined) {
			layer.install = j.install || null;
			set('install');
		}
		if (ctx.mode === 'prod' && j.build !== undefined) {
			layer.build = j.build == null ? [] : Array.isArray(j.build) ? j.build.filter(Boolean) : [j.build];
			set('build');
		}
		const start = ctx.mode === 'dev' ? j.dev : j.start;
		if (start !== undefined) {
			layer.start = start || null;
			set(ctx.mode === 'dev' ? 'dev command' : 'start');
		} else if (ctx.mode === 'dev' && j.start && !ctx.sofar.start) {
			layer.start = j.start;
			set('start (no dev command, so the production start)');
		}
		if (j.port !== undefined) {
			layer.port = Number(j.port) || null;
			set('port');
		}
		if (j.env && typeof j.env === 'object') layer.env = Object.fromEntries(Object.entries(j.env).map(([k, v]) => [k, String(v)]));
		return layer;
	},
};

export interface ResolvePlanOptions {
	/** The project's directory (absolute). */
	dir: string;
	/** `dev` (the default) or `prod`. */
	mode?: ProjectMode;
	/** Leave the Dockerfile out (it's only read as a recipe when this is false, the default). */
	ignoreDockerfile?: boolean;
	/** The Dockerfile reader; passed in so plan.ts has no dependency on it (see project/index.ts). */
	dockerfile?: ProjectReader;
}

/** The plan for the project in `dir`. */
export function resolvePlan(files: ProjectFiles, opts: ResolvePlanOptions): ProjectPlan {
	const mode = opts.mode ?? 'dev';
	const dir = opts.dir.replace(/\/+$/, '') || '/';
	let plan = emptyPlan(dir, mode);
	for (const reader of languageReaders) {
		const layer = reader.read(readerContext(files, dir, mode, plan));
		if (layer) plan = applyLayer(plan, layer);
	}
	if (opts.dockerfile && !opts.ignoreDockerfile) {
		const layer = opts.dockerfile.read(readerContext(files, dir, mode, plan));
		if (layer) plan = applyLayer(plan, layer);
	}
	const lj = lifoJsonReader.read(readerContext(files, dir, mode, plan));
	if (lj) plan = applyLayer(plan, lj);
	if (!plan.start) plan.notes.push(`no ${mode === 'dev' ? 'dev command' : 'start command'} found: set one in lifo.json ("${mode === 'dev' ? 'dev' : 'start'}")`);
	return plan;
}

// ─── Running it here ───

/**
 * The command that provides each toolchain. A place that runs plans says it has a toolchain when
 * this command resolves there. New toolchains (go, cargo, ...) only need an entry here and a
 * reader.
 */
export const NEED_COMMANDS: Record<string, string> = {
	node: 'node',
	python: 'python3',
	go: 'go',
	rust: 'cargo',
	bun: 'bun',
	deno: 'deno',
	java: 'java',
	php: 'php',
	ruby: 'ruby',
	dotnet: 'dotnet',
};

/** The needs `has` says no to. */
export function missingNeeds(plan: ProjectPlan, has: (need: ProjectNeed) => boolean): ProjectNeed[] {
	return plan.needs.filter((n) => !has(n));
}

/** "go (FROM golang:1.23 in Dockerfile), rust (Cargo.toml)" */
export function describeNeeds(needs: ProjectNeed[]): string {
	return needs.map((n) => `${n.name}${n.version ? ` ${n.version}` : ''} (${n.from})`).join(', ');
}

/** The plan as text, for `lifo plan`. */
export function formatPlan(plan: ProjectPlan): string {
	const lines: string[] = [];
	const row = (k: string, v: string) => lines.push(`  ${k.padEnd(9)}${v}`);
	lines.push(`${plan.mode === 'dev' ? 'Dev' : 'Production'} plan for ${plan.dir}${plan.sources.length ? ` (from ${plan.sources.join(', ')})` : ''}`);
	lines.push('');
	if (plan.framework) row('framework', plan.framework);
	row('install', plan.install ? `${plan.install}${plan.installedWhen ? `  (skipped when ${plan.installedWhen} exists)` : ''}` : '-');
	if (plan.mode === 'prod' || plan.build.length) {
		if (!plan.build.length) row('build', '-');
		plan.build.forEach((b, i) => row(i === 0 ? 'build' : '', b));
	}
	row(plan.mode === 'dev' ? 'dev' : 'start', plan.start || '-');
	row('port', plan.port ? String(plan.port) : '-');
	const env = Object.entries(plan.env);
	if (env.length) row('env', env.map(([k, v]) => `${k}=${v}`).join(' '));
	const benv = Object.entries(plan.buildEnv);
	if (benv.length) row('build env', benv.map(([k, v]) => `${k}=${v}`).join(' '));
	if (plan.needs.length) row('needs', describeNeeds(plan.needs));
	if (plan.skipped.length) {
		lines.push('');
		lines.push('  Left out:');
		for (const s of plan.skipped) lines.push(`    ${s.what}: ${s.why}`);
	}
	if (plan.notes.length) {
		lines.push('');
		for (const n of plan.notes) lines.push(`  · ${n}`);
	}
	return lines.join('\n') + '\n';
}

/**
 * A start line that installs first when nothing is installed yet: for a dev box in the cloud,
 * where `--exclude node_modules` pushes are common. One group, so a caller that backgrounds it
 * (`<start> &`) backgrounds the install too: `{ test -e node_modules || npm install; npm run dev; }`
 */
export function startWithInstall(plan: ProjectPlan): string | null {
	if (!plan.start) return null;
	if (!plan.install) return plan.start;
	return plan.installedWhen ? `{ test -e ${shellQuote(plan.installedWhen)} || ${plan.install}; ${plan.start}; }` : `{ ${plan.install} && ${plan.start}; }`;
}

export function shellQuote(s: string): string {
	return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
