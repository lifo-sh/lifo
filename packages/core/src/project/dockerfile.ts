/**
 * project/dockerfile.ts: a Dockerfile read as a recipe, not an image.
 *
 * Lifo doesn't pull base images or run their binaries. It reads what the Dockerfile says about
 * the project and runs that on its own toolchains:
 *
 *   FROM node:20        → needs node 20 (golang → go, python → python, ...); FROM <stage> inherits
 *   WORKDIR             → the project's directory (a deeper WORKDIR is a `cd` for later steps)
 *   COPY/ADD from the build context → nothing to do: the files are already in the box
 *   COPY --from=<stage> → a `cp` after the build, or the directory the app starts in (Next.js's
 *                         `.next/standalone ./`)
 *   ADD <url>           → `curl` in the build
 *   RUN                 → build steps (system package installs are left out, with why)
 *   ENV, ARG            → the start's env (final stage), the build's env (earlier stages), `${VAR}`
 *   EXPOSE              → the port
 *   CMD, ENTRYPOINT     → the start command
 *   USER, VOLUME, HEALTHCHECK, LABEL, SHELL, ... → left out, with why
 *
 * In prod the Dockerfile is the project's production recipe, so its build and start win over
 * package.json's. In dev a language reader's dev command wins; the Dockerfile adds its env, port
 * and needs (and is the whole recipe when no language reader knew the project).
 */

import type { PlanLayer, ProjectNeed, ProjectReader } from './plan.js';
import { shellQuote } from './plan.js';

export interface DockerInstruction {
	op: string;
	/** Everything after the instruction word, continuation lines joined. */
	args: string;
	line: number;
}

export interface DockerStage {
	from: string;
	name: string | null;
	instructions: DockerInstruction[];
}

/** Instructions grouped by stage. Comments, blank lines and parser directives are dropped. */
export function parseDockerfile(text: string): { stages: DockerStage[]; preamble: DockerInstruction[] } {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const instructions: DockerInstruction[] = [];
	let i = 0;
	while (i < lines.length) {
		const startLine = i + 1;
		let line = lines[i++];
		if (/^\s*(#|$)/.test(line)) continue;
		let joined = '';
		// Continuation lines; comment lines inside a continuation are skipped, as Docker does.
		while (/\\\s*$/.test(line)) {
			joined += line.replace(/\s*\\\s*$/, '') + ' ';
			if (i >= lines.length) {
				line = '';
				break;
			}
			line = lines[i++];
			while (i <= lines.length && /^\s*#/.test(line)) line = i < lines.length ? lines[i++] : '';
			line = line.trimStart();
		}
		joined += line;
		// A heredoc (RUN <<EOF ... EOF): its body goes with the instruction.
		const heredoc = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/.exec(joined);
		if (heredoc) {
			const body: string[] = [];
			while (i < lines.length && lines[i].trim() !== heredoc[1]) body.push(lines[i++]);
			i++;
			joined += '\n' + body.join('\n') + '\n' + heredoc[1];
		}
		const m = /^\s*([A-Za-z]+)\s*(.*)$/s.exec(joined);
		if (!m) continue;
		instructions.push({ op: m[1].toUpperCase(), args: m[2].trim(), line: startLine });
	}
	const stages: DockerStage[] = [];
	const preamble: DockerInstruction[] = [];
	for (const ins of instructions) {
		if (ins.op === 'FROM') {
			const words = ins.args.split(/\s+/).filter((w) => !w.startsWith('--'));
			const asAt = words.findIndex((w) => w.toUpperCase() === 'AS');
			stages.push({ from: words[0] || '', name: asAt >= 0 ? words[asAt + 1] || null : null, instructions: [] });
		} else if (stages.length) stages[stages.length - 1].instructions.push(ins);
		else preamble.push(ins);
	}
	return { stages, preamble };
}

/** `["node", "server.js"]` → `node server.js`; a shell form stays as written. */
export function commandOf(args: string): string {
	const t = args.trim();
	if (t.startsWith('[')) {
		try {
			const arr = JSON.parse(t);
			if (Array.isArray(arr)) {
				// ["sh", "-c", "line"] is the line itself.
				if (arr.length === 3 && /^(\/bin\/)?(ba)?sh$/.test(arr[0]) && arr[1] === '-c') return String(arr[2]);
				return arr.map((a) => shellQuote(String(a))).join(' ');
			}
		} catch {
			/* a shell form that starts with [ */
		}
	}
	return t;
}

/** Image → the toolchain it provides. Base OS images provide none. */
const IMAGE_NEEDS: Array<[RegExp, string]> = [
	[/(^|\/)(node|nodejs)$/, 'node'],
	[/(^|\/)distroless\/nodejs\d*(-debian\d+)?$/, 'node'],
	[/(^|\/)(python|pypy)$/, 'python'],
	[/(^|\/)golang$/, 'go'],
	[/(^|\/)rust$/, 'rust'],
	[/^oven\/bun$/, 'bun'],
	[/^denoland\/deno$/, 'deno'],
	[/(^|\/)(openjdk|eclipse-temurin|amazoncorretto|maven|gradle)$/, 'java'],
	[/(^|\/)php$/, 'php'],
	[/(^|\/)ruby$/, 'ruby'],
	[/(^|\/)dotnet\/(sdk|aspnet|runtime)$/, 'dotnet'],
];
const BASE_IMAGES = /(^|\/)(alpine|debian|ubuntu|busybox|scratch|centos|fedora|rockylinux|almalinux|amazonlinux|distroless\/(static|base|cc)(-debian\d+)?|ubi\d*(-minimal)?)$/;

export function needOfImage(image: string, from: string): ProjectNeed | null | 'base' {
	const [ref] = image.split('@');
	const colon = ref.lastIndexOf(':');
	const slash = ref.lastIndexOf('/');
	const name = (colon > slash ? ref.slice(0, colon) : ref).replace(/^(docker\.io\/)?(library\/)?/, '').replace(/^(gcr\.io|mcr\.microsoft\.com|public\.ecr\.aws\/[^/]+|ghcr\.io)\//, '');
	const tag = colon > slash ? ref.slice(colon + 1) : '';
	for (const [re, need] of IMAGE_NEEDS) if (re.test(name)) return { name: need, ...(tag && tag !== 'latest' ? { version: tag } : {}), from };
	if (BASE_IMAGES.test(name)) return 'base';
	return null;
}

/** System package managers: what they install isn't in a Lifo box, or kept by a container box across wakes. */
const SYSTEM_PKG = /^(sudo\s+)?(apt-get|apt|apk|yum|dnf|microdnf|zypper|pacman|dpkg|rpm|update-ca-certificates)\b/;
const SYSTEM_CLEANUP = /^(rm\s+-rf?\s+\/var\/(lib\/apt\/lists|cache\/(apk|apt|yum|dnf))\S*|apt-get\s+clean|apk\s+cache\s+clean)/;
/** Accounts and permissions: a box has one user. */
const USER_ADMIN = /^(sudo\s+)?(addgroup|adduser|useradd|groupadd|usermod|chown|chgrp)\b/;

/** Splits a RUN line on top-level `&&` (outside quotes). */
export function splitAnd(line: string): string[] {
	const parts: string[] = [];
	let cur = '';
	let q: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === q) q = null;
			else if (c === '\\' && q === '"') {
				cur += c + (line[++i] ?? '');
				continue;
			}
			cur += c;
			continue;
		}
		if (c === "'" || c === '"') q = c;
		if (c === '&' && line[i + 1] === '&') {
			parts.push(cur.trim());
			cur = '';
			i++;
			continue;
		}
		cur += c;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts.filter(Boolean);
}

function substitute(s: string, vars: Record<string, string>): string {
	return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, def, b) => {
		const k = a || b;
		if (k in vars) return vars[k];
		return def !== undefined ? def : all;
	});
}

/** `K=V K2="v 2"` or the legacy `K V` form. */
function parseKeyValues(args: string): Record<string, string> {
	const out: Record<string, string> = {};
	const t = args.trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/s.exec(t);
		if (m) out[m[1]] = unquote(m[2].trim());
		return out;
	}
	const re = /([A-Za-z_][A-Za-z0-9_.]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(t))) out[m[1]] = unquote(m[2]);
	return out;
}

function unquote(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1).replace(/\\(.)/g, '$1');
	return v;
}

/** The flags and paths of a COPY/ADD: `--from=builder --chown=a:b src1 src2 dest` (or the JSON form). */
function copyArgs(args: string): { flags: Record<string, string>; srcs: string[]; dest: string } {
	const words: string[] = [];
	const flags: Record<string, string> = {};
	let rest = args.trim();
	while (rest.startsWith('--')) {
		const m = /^--([a-z-]+)(?:=(\S*))?\s*/.exec(rest);
		if (!m) break;
		flags[m[1]] = m[2] ?? '';
		rest = rest.slice(m[0].length);
	}
	if (rest.startsWith('[')) {
		try {
			words.push(...JSON.parse(rest).map(String));
		} catch {
			words.push(...rest.split(/\s+/));
		}
	} else words.push(...rest.split(/\s+/).filter(Boolean));
	const dest = words.pop() || '.';
	return { flags, srcs: words, dest };
}

/** A path inside a stage, relative to that stage's root WORKDIR, or null when it's outside it. */
function relTo(root: string, cwd: string, p: string): string | null {
	const abs = p.startsWith('/') ? normalize(p) : normalize(`${cwd}/${p}`);
	if (abs === root) return '.';
	if (root === '/') return abs.slice(1);
	if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
	return null;
}

function normalize(p: string): string {
	const out: string[] = [];
	for (const s of p.split('/')) {
		if (!s || s === '.') continue;
		if (s === '..') out.pop();
		else out.push(s);
	}
	return '/' + out.join('/');
}

const IGNORED: Record<string, string> = {
	USER: 'a box runs as its own user',
	VOLUME: "a box's files are already kept",
	HEALTHCHECK: 'Lifo checks the port instead',
	LABEL: 'metadata only',
	MAINTAINER: 'metadata only',
	SHELL: 'steps run in the box shell',
	STOPSIGNAL: 'Lifo stops the app itself',
	ONBUILD: 'only applies to images built from this one',
};

interface StageState {
	root: string;
	cwd: string;
	env: Record<string, string>;
	args: Record<string, string>;
	needs: ProjectNeed[];
	/** Build steps this stage contributes. */
	steps: string[];
	cmd: string | null;
	entrypoint: string | null;
	port: number | null;
	/** COPY --from=<stage> in this stage. */
	copies: Array<{ srcs: string[]; dest: string; from: StageState; ins: DockerInstruction }>;
}

/** Reads a Dockerfile's text into a plan layer. Exported for tests and for other readers. */
export function dockerfileLayer(text: string, mode: 'dev' | 'prod', opts: { haveLanguage: boolean; source?: string } = { haveLanguage: false }): PlanLayer {
	const source = opts.source ?? 'Dockerfile';
	const { stages, preamble } = parseDockerfile(text);
	const skipped: Array<{ what: string; why: string }> = [];
	const notes: string[] = [];
	if (!stages.length) return { source, notes: [`${source} has no FROM: ignored`] };

	const globalArgs: Record<string, string> = {};
	for (const ins of preamble) if (ins.op === 'ARG') Object.assign(globalArgs, parseKeyValues(ins.args.includes('=') ? ins.args : `${ins.args}=`));
	for (const k of Object.keys(globalArgs)) if (globalArgs[k] === '') delete globalArgs[k];

	const byName = new Map<string, StageState>();
	const states: StageState[] = [];
	const short = (ins: DockerInstruction) => {
		const s = `${ins.op} ${ins.args}`.replace(/\s+/g, ' ');
		return s.length > 70 ? s.slice(0, 67) + '...' : s;
	};

	stages.forEach((stage) => {
		const from = substitute(stage.from, globalArgs);
		const parent = byName.get(from.toLowerCase()) ?? (/^\d+$/.test(from) ? states[Number(from)] : undefined);
		const st: StageState = parent
			? { ...parent, env: { ...parent.env }, args: { ...globalArgs }, needs: [...parent.needs], steps: [], copies: [] }
			: { root: '', cwd: '', env: {}, args: { ...globalArgs }, needs: [], steps: [], cmd: null, entrypoint: null, port: null, copies: [] };
		if (!parent) {
			const need = needOfImage(from, `FROM ${from} in ${source}`);
			if (need && need !== 'base') st.needs.push(need);
			else if (!need) skipped.push({ what: `FROM ${from}`, why: "an image Lifo doesn't know: only what the Dockerfile itself does is run" });
		}
		const vars = () => ({ ...st.args, ...st.env });
		const rel = () => (st.cwd === st.root || !st.root ? '' : relTo(st.root, st.root, st.cwd));
		const inDir = (cmd: string) => {
			const r = rel();
			return r && r !== '.' ? `cd ${shellQuote(r)} && ${cmd}` : cmd;
		};

		for (const ins of stage.instructions) {
			const args = ins.op === 'RUN' || ins.op === 'CMD' || ins.op === 'ENTRYPOINT' ? ins.args : substitute(ins.args, vars());
			switch (ins.op) {
				case 'WORKDIR': {
					const p = args.startsWith('/') ? normalize(args) : normalize(`${st.cwd || '/'}/${args}`);
					if (!st.root) st.root = p;
					st.cwd = relTo(st.root, st.root, p) != null ? p : st.root;
					if (st.cwd !== p) notes.push(`WORKDIR ${args} is outside ${st.root}: steps after it run in the project's directory`);
					break;
				}
				case 'ENV':
					Object.assign(st.env, parseKeyValues(args));
					break;
				case 'ARG': {
					const kv = args.includes('=') ? parseKeyValues(args) : { [args.trim()]: '' };
					for (const [k, v] of Object.entries(kv)) if (!(k in st.args) || v) st.args[k] = v || st.args[k] || globalArgs[k] || '';
					break;
				}
				case 'EXPOSE': {
					const n = Number(/^(\d+)/.exec(args)?.[1]);
					if (n > 0 && n < 65536 && st.port == null) st.port = n;
					break;
				}
				case 'RUN': {
					const flags = /^(--[a-z-]+=\S+\s+)+/.exec(ins.args)?.[0] ?? '';
					if (flags) notes.push(`RUN ${flags.trim()}: flags ignored`);
					const line = commandOf(ins.args.slice(flags.length));
					if (/<<-?\s*["']?[A-Za-z_]/.test(line)) {
						skipped.push({ what: short(ins), why: 'heredoc RUN steps are not supported yet: put the script in a file and RUN it' });
						break;
					}
					const parts = splitAnd(line);
					const kept: string[] = [];
					const dropped: string[] = [];
					for (const p of parts) {
						if (SYSTEM_PKG.test(p) || SYSTEM_CLEANUP.test(p) || USER_ADMIN.test(p)) dropped.push(p);
						else {
							const npm = toNpm(p);
							if (npm === null) dropped.push(p);
							else {
								if (npm !== p) notes.push(`"${p}" runs as "${npm}" (Lifo installs with npm)`);
								kept.push(npm);
							}
						}
					}
					if (dropped.length) {
						const system = dropped.some((p) => SYSTEM_PKG.test(p));
						const users = dropped.some((p) => USER_ADMIN.test(p));
						skipped.push({
							what: dropped.length === parts.length ? short(ins) : `${dropped.join(' && ').slice(0, 70)} (in a RUN)`,
							why: system
								? "installs system packages: a Lifo box has none, and a container box doesn't keep them across wakes yet"
								: users
									? 'manages users or ownership: a box has one user'
									: 'sets up a package manager Lifo replaces with npm',
						});
					}
					if (kept.length) st.steps.push(inDir(kept.join(' && ')));
					break;
				}
				case 'COPY':
				case 'ADD': {
					const { flags, srcs, dest } = copyArgs(args);
					const from = flags.from;
					if (ins.op === 'ADD' && srcs.length === 1 && /^https?:\/\//.test(srcs[0])) {
						const target = dest.endsWith('/') ? `${dest}${srcs[0].split('/').pop()}` : dest;
						const here = st.cwd || st.root || '/';
						const r = target.startsWith('/') ? relTo(here, here, target) : target;
						if (r == null) skipped.push({ what: short(ins), why: "downloads outside the project's directory" });
						else st.steps.push(inDir(`curl -fsSL ${shellQuote(srcs[0])} -o ${shellQuote(r)}`));
						break;
					}
					if (ins.op === 'ADD' && srcs.some((s) => /\.(tar(\.(gz|bz2|xz))?|tgz)$/.test(s))) {
						notes.push(`${short(ins)}: archives are copied, not unpacked`);
					}
					if (!from) break; // from the build context: the files are already here
					const src = byName.get(from.toLowerCase()) ?? (/^\d+$/.test(from) ? states[Number(from)] : undefined);
					if (!src) {
						skipped.push({ what: short(ins), why: `copies from the image ${from}, which Lifo doesn't pull` });
						break;
					}
					st.copies.push({ srcs, dest, from: src, ins });
					break;
				}
				case 'CMD':
					st.cmd = commandOf(substitute(args, vars()));
					break;
				case 'ENTRYPOINT':
					st.entrypoint = commandOf(substitute(args, vars()));
					break;
				default:
					if (IGNORED[ins.op]) skipped.push({ what: short(ins), why: IGNORED[ins.op] });
					else notes.push(`${ins.op} (line ${ins.line}) isn't known: ignored`);
			}
		}
		states.push(st);
		if (stage.name) byName.set(stage.name.toLowerCase(), st);
	});

	const final = states[states.length - 1];
	// Every stage's steps run in one directory, in order: earlier stages are the build's first part.
	const build: string[] = [];
	const buildEnv: Record<string, string> = {};
	for (const st of states) {
		build.push(...st.steps);
		if (st !== final) Object.assign(buildEnv, st.env);
	}

	// The final stage's COPY --from: where the app's files end up. One copied to the stage's root
	// from a subdirectory (Next.js standalone) makes that subdirectory the app's; the others are
	// `cp` steps after the build (into that subdirectory, when there is one).
	let appDir = '.';
	const copies = final.copies;
	const relSrc = (c: (typeof copies)[number], s: string) => relTo(c.from.root || '/', c.from.root || '/', s);
	const relDest = (c: (typeof copies)[number]) => relTo(final.root || '/', final.cwd || final.root || '/', c.dest);
	for (const c of copies) {
		const d = relDest(c);
		if (d === '.' && c.srcs.length === 1) {
			const s = relSrc(c, c.srcs[0]);
			if (s && s !== '.') appDir = s;
		}
	}
	for (const c of copies) {
		const d = relDest(c);
		for (const s0 of c.srcs) {
			const s = relSrc(c, s0);
			if (s == null || d == null) {
				skipped.push({ what: `${c.ins.op} ${c.ins.args}`.slice(0, 70), why: "copies outside the project's directory" });
				continue;
			}
			if (d === '.' && s === appDir) continue;
			const target = appDir === '.' ? d : d === '.' ? appDir : `${appDir}/${d}`;
			if (s === target || (d === '.' && s === '.')) continue;
			const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
			build.push(`${parent ? `mkdir -p ${shellQuote(parent)} && ` : ''}cp -r ${shellQuote(s)} ${shellQuote(target)}`);
		}
	}

	let start = final.entrypoint && final.cmd ? `${final.entrypoint} ${final.cmd}` : final.entrypoint || final.cmd;
	if (start && appDir !== '.') start = `cd ${shellQuote(appDir)} && ${start}`;
	const finalRel = final.cwd && final.root && final.cwd !== final.root ? relTo(final.root, final.root, final.cwd) : null;
	if (start && finalRel && finalRel !== '.' && appDir === '.') start = `cd ${shellQuote(finalRel)} && ${start}`;
	if (appDir !== '.') notes.push(`the app runs from ${appDir} (the final stage copies it to its WORKDIR)`);

	const needs: ProjectNeed[] = [];
	for (const st of states) for (const n of st.needs) if (!needs.some((x) => x.name === n.name)) needs.push(n);

	const layer: PlanLayer = { source, needs, skipped, notes };
	if (mode === 'dev' && opts.haveLanguage) {
		// A dev server from package.json (or another reader): the Dockerfile's port, env and steps
		// are production's (EXPOSE 3000, NODE_ENV=production), so only its needs apply.
		notes.push(`${source}: only its toolchains apply in dev; its build, env, port and CMD are production's (lifo build, lifo start)`);
		return layer;
	}
	const port = final.port ?? states.find((s) => s.port != null)?.port ?? null;
	if (port != null) layer.port = port;
	if (Object.keys(final.env).length) layer.env = final.env;
	layer.build = build;
	if (Object.keys(buildEnv).length) layer.buildEnv = buildEnv;
	// When its RUN steps install the dependencies, a language reader's install isn't run as well.
	if (build.some((b) => INSTALLS.test(b))) {
		layer.install = null;
		layer.installedWhen = null;
	}
	if (start) layer.start = start;
	notes.push(`build and ${mode === 'prod' ? 'start' : 'dev command'}: ${source} (${stages.length} stage${stages.length === 1 ? '' : 's'})`);
	if (mode === 'dev' && build.length) notes.push(`nothing else knows this project, so ${source}'s build runs before its start in dev too`);
	return layer;
}

/** A step that installs dependencies. */
const INSTALLS = /(^|[\s;&|(])(npm\s+(ci|install|i)|pip3?\s+install|python3?\s+-m\s+pip\s+install)(\s|$|;)/;

/**
 * yarn, pnpm and corepack lines as npm runs them (Lifo has npm only); null drops the line
 * (`corepack enable`). Anything else comes back unchanged.
 */
export function toNpm(cmd: string): string | null {
	const t = cmd.trim();
	if (/^corepack\s+(enable|prepare|use)\b/.test(t) || /^npm\s+(i|install)\s+(-g|--global)\s+(pnpm|yarn)(@\S*)?$/.test(t)) return null;
	let m = /^(yarn|pnpm)(\s+install|\s+i)?(\s+--[\w-]+(=\S+)?)*\s*$/.exec(t);
	if (m && (m[1] === 'yarn' || m[2])) return 'npm install';
	m = /^(yarn|pnpm)\s+(add)\s+(.*)$/.exec(t);
	if (m) return `npm install ${m[3]}`;
	m = /^(yarn|pnpm)\s+run\s+(.*)$/.exec(t);
	if (m) return `npm run ${m[2]}`;
	m = /^(yarn|pnpm)\s+(start|test)\b(.*)$/.exec(t);
	if (m) return `npm ${m[2]}${m[3]}`;
	m = /^(yarn|pnpm)\s+(exec|dlx)\s+(.*)$/.exec(t);
	if (m) return `npx ${m[3]}`;
	m = /^(yarn|pnpm)\s+([\w:.-]+)(.*)$/.exec(t);
	if (m && !['install', 'i', 'add', 'remove', 'why', 'config', 'set', 'cache', 'global'].includes(m[2])) return `npm run ${m[2]}${m[3]}`;
	return t;
}

export const dockerfileReader: ProjectReader = {
	name: 'Dockerfile',
	read(ctx) {
		const text = ctx.read('Dockerfile');
		if (text == null) return null;
		return dockerfileLayer(text, ctx.mode, { haveLanguage: !!ctx.sofar.start });
	},
};
