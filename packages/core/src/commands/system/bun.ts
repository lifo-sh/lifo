/**
 * bun and bunx: the Bun CLI in a box, run on Lifo's npm and node.
 *
 * Real Bun is a native binary (Zig and JavaScriptCore) with no WebAssembly build, so a box maps
 * its commands onto what it already runs:
 *
 *   bun install | i [pkgs]         npm install (-d/-D/--dev, -E/--exact, --optional, --peer, -g)
 *   bun add | a <pkgs>             npm install <pkgs>
 *   bun remove | rm <pkgs>         npm uninstall <pkgs>
 *   bun update [pkgs] [--latest]   reinstall within the ranges; named packages go to their latest
 *   bun run <script|file|bin>      the package.json script, node <file> (TypeScript and JSX too),
 *                                  or a command from node_modules
 *   bun <script|file>              the same, without `run`
 *   bun x | bunx <pkg> [args]      npx
 *   bun create <template> [args]   create-<template> through npx (bun create vite my-app)
 *   bun init [dir]                 a blank TypeScript project, then bun install
 *   bun pm ls|bin|cache|pack       npm list, the bin directory, the npx cache, npm pack
 *   bun info <pkg>                 npm info
 *   bun exec "<command>"           the box's shell
 *
 * Every run sets npm_config_user_agent to Bun's, so create-next-app, create-vite and the
 * TanStack CLI pick bun (and run `bun install`) as they do on a real machine. As in Bun, running
 * a script or a file loads .env, .env.<NODE_ENV> and .env.local.
 *
 * Not here yet: Bun's own APIs (Bun.serve, Bun.file, bun:sqlite), bun test and bun build.
 */

import type { Command, CommandContext } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { Kernel } from '../../kernel/index.js';
import { resolve, join, basename, dirname } from '../../utils/path.js';
import {
	runScriptWithHooks, findLocalBinByName, initializerPackage, parsePackageSpec,
	type PackageJson, type ScriptBanner, type ShellExecuteFn,
} from './npm.js';

/** The Bun release whose CLI this maps (bun --version). */
export const BUN_VERSION = '1.4.5';
export const BUN_USER_AGENT = `bun/${BUN_VERSION} npm/? node/v24.3.0 linux x64`;

const NOTE = "💡 bun in a Lifo box runs on Lifo's npm and node (Bun itself is a native binary). Bun's own APIs (Bun.serve, bun:sqlite), bun test and bun build aren't here yet.\n";

const USAGE = `Bun in a Lifo box: Bun's CLI on Lifo's npm and node.

Usage: bun <command> [...flags] [...args]

Commands:
  run       ./my-script.ts     Run a file (TypeScript and JSX included) or a package.json script
  <file>    ./index.tsx        Run a file, like bun run
  <script>  dev                Run a package.json script, like bun run
  x         prettier           Run a package's command, installing it if needed (also bunx)
  exec      "echo hi"          Run a command in the box's shell

  install                      Install the dependencies in package.json (bun i)
  add       react              Add a dependency (-d dev, -E exact, --optional, --peer, -g global)
  remove    react              Remove a dependency (bun rm)
  update    [react] [--latest] Update dependencies
  info      react              Show a package's details from the registry
  pm        ls | bin | cache   Package manager utilities

  init      [dir]              Start a blank TypeScript project
  create    vite my-app        Run a create-<template> package (bunx create-vite my-app)

Flags:
  --cwd <dir>                  Run in another directory
  --env-file <file>            Load this env file instead of .env, .env.<NODE_ENV>, .env.local
  -e, --eval <code>            Evaluate code
  -p, --print <code>           Evaluate code and print the result
  -v, --version                Print the version

Not in a box yet: Bun's own APIs (Bun.serve, Bun.file, bun:sqlite), bun test, bun build,
bun create <github-user/repo>, workspaces (--filter).
`;

const BUNX_USAGE = `Usage: bunx [--bun] [-p <package>] <package>[@version] [args...]

Runs a package's command, installing it into a cache if the project doesn't have it (npx in a box).
`;

// Global and run flags that take a value (skipped together with it unless handled).
const VALUE_FLAGS = new Set([
	'--define', '-d', '--preload', '-r', '--require', '--import', '--conditions', '--tsconfig-override',
	'--jsx-factory', '--jsx-fragment', '--jsx-import-source', '--jsx-runtime', '--main-fields',
	'--extension-order', '--loader', '-l', '--port', '--shell', '--elide-lines', '--config', '-c',
	'--console-depth', '--max-http-header-size', '--dns-result-order', '--title', '--unhandled-rejections',
]);

// Install flags that take a value; --registry is passed on, the rest don't apply in a box.
const INSTALL_VALUE_FLAGS = new Set([
	'--registry', '--cwd', '--backend', '--cache-dir', '--linker', '--omit', '--concurrent-scripts',
	'--network-concurrency', '--config', '-c', '--filter', '-F', '--ca', '--cafile', '--minimum-release-age',
]);

interface RunFlags {
	cwd?: string;
	envFiles: string[];
	watch: boolean;
	ifPresent: boolean;
	filter: boolean;
	eval?: string;
	print?: string;
}

/** Parse the flags in front of a command or a run target; returns the flags and what's left. */
function parseRunFlags(args: string[], flags: RunFlags = { envFiles: [], watch: false, ifPresent: false, filter: false }): { flags: RunFlags; rest: string[] } {
	let i = 0;
	const value = (a: string, name: string): string | undefined => {
		if (a.startsWith(name + '=')) return a.slice(name.length + 1);
		return args[++i];
	};
	for (; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith('-') || a === '-') break;
		if (a === '--') { i++; break; }
		const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
		if (a === '-v' || a === '--version' || a === '--revision' || a === '-h' || a === '--help') break;
		if (name === '--cwd') flags.cwd = value(a, name);
		else if (name === '--env-file') { const f = value(a, name); if (f) flags.envFiles.push(f); }
		else if (name === '-e' || name === '--eval') flags.eval = value(a, name);
		else if (name === '-p' || name === '--print') flags.print = value(a, name);
		else if (name === '--filter' || name === '-F') { flags.filter = true; value(a, name); }
		else if (a === '--watch' || a === '--hot') flags.watch = true;
		else if (a === '--if-present') flags.ifPresent = true;
		else if (VALUE_FLAGS.has(name) && !a.includes('=')) i++;
		// Every other flag (--bun, --smol, --silent, --no-install, ...) changes nothing in a box.
	}
	return { flags, rest: args.slice(i) };
}

function readPackageJson(c: CommandContext): (PackageJson & Record<string, unknown>) | null {
	try {
		return JSON.parse(c.vfs.readFileString(join(c.cwd, 'package.json')));
	} catch {
		return null;
	}
}

function writePackageJson(c: CommandContext, pkg: object): void {
	c.vfs.writeFile(join(c.cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

/** Parse a dotenv file: KEY=value lines, `export` prefixes, quotes, comments, ${VAR} expansion. */
export function parseDotEnv(text: string, lookup: (name: string) => string | undefined = () => undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const expand = (v: string) => v.replace(/\\?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) =>
		m.startsWith('\\') ? m.slice(1) : (out[name] ?? lookup(name) ?? ''));
	const re = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|[^\n#]*)?\s*(?:#.*)?$/gm;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		let v = (m[2] ?? '').trim();
		const q = v[0];
		if (q === "'" || q === '`') v = v.slice(1, -1);
		else if (q === '"') v = expand(v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"'));
		else v = expand(v);
		out[m[1]] = v;
	}
	return out;
}

/** The env Bun gives a script or a file: .env files under the process env (which wins). */
function envWithDotEnv(c: CommandContext, files: string[]): Record<string, string> {
	const nodeEnv = c.env.NODE_ENV || 'development';
	const names = files.length > 0 ? files : ['.env', `.env.${nodeEnv}`, ...(nodeEnv === 'test' ? [] : ['.env.local'])];
	const loaded: Record<string, string> = {};
	for (const name of names) {
		const path = resolve(c.cwd, name);
		if (!c.vfs.exists(path)) continue;
		try {
			Object.assign(loaded, parseDotEnv(c.vfs.readFileString(path), (k) => c.env[k] ?? loaded[k]));
		} catch { /* unreadable: skip */ }
	}
	return { ...loaded, ...c.env };
}

const bunBanner: ScriptBanner = (_pkg, _name, script, ctx) => {
	ctx.stderr.write(ctx.stderr.isTTY ? `\x1b[2m$ ${script}\x1b[22m\n` : `$ ${script}\n`);
};

// Boxes that have seen the note (keyed by their filesystem), so it shows once per box.
const noted = new WeakSet<object>();

export function createBunCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel): Command {
	const run = async (name: string, args: string[], c: CommandContext): Promise<number> => {
		const cmd = await registry.resolve(name);
		if (!cmd) {
			c.stderr.write(`bun: ${name} isn't available in this box\n`);
			return 127;
		}
		return cmd({ ...c, args });
	};

	const header = (c: CommandContext, sub: string) => c.stdout.write(`bun ${sub} v${BUN_VERSION} (lifo)\n\n`);

	// ── Packages ──

	async function install(c: CommandContext, args: string[], sub: 'install' | 'add'): Promise<number> {
		const pkgs: string[] = [];
		let dev = false, exact = false, optional = false, peer = false, global = false;
		let env = c.env;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (a === '-d' || a === '-D' || a === '--dev' || a === '--development' || a === '--save-dev') dev = true;
			else if (a === '-E' || a === '--exact') exact = true;
			else if (a === '--optional') optional = true;
			else if (a === '--peer') peer = true;
			else if (a === '-g' || a === '--global') global = true;
			else if (a === '--registry' || a.startsWith('--registry=')) {
				const url = a.includes('=') ? a.slice(11) : args[++i];
				if (url) env = { ...env, NPM_REGISTRY: url };
			} else if (INSTALL_VALUE_FLAGS.has(a)) i++;
			else if (!a.startsWith('-')) pkgs.push(a);
		}
		if (sub === 'add' && pkgs.length === 0) {
			c.stderr.write('error: no package specified (bun add <package>)\n');
			return 1;
		}
		header(c, sub);
		const code = await run('npm', ['install', ...(global ? ['-g'] : []), ...(dev ? ['-D'] : []), ...pkgs], { ...c, env });
		if (code !== 0 || global || pkgs.length === 0 || !(exact || optional || peer)) return code;
		// npm saved ^<version> under dependencies; Bun's flags change the range or the section.
		const pkg = readPackageJson(c);
		if (!pkg) return code;
		const sections = pkg as unknown as Record<string, Record<string, string> | undefined>;
		const from = dev ? 'devDependencies' : 'dependencies';
		const to = optional ? 'optionalDependencies' : peer ? 'peerDependencies' : from;
		for (const spec of pkgs) {
			const { name } = parsePackageSpec(spec);
			const deps = sections[from];
			if (!deps || deps[name] === undefined) continue;
			const range = exact ? deps[name].replace(/^[\^~]/, '') : deps[name];
			delete deps[name];
			(sections[to] ??= {})[name] = range;
		}
		writePackageJson(c, pkg);
		return code;
	}

	async function remove(c: CommandContext, args: string[]): Promise<number> {
		const global = args.includes('-g') || args.includes('--global');
		const pkgs = args.filter((a) => !a.startsWith('-'));
		if (pkgs.length === 0) {
			c.stderr.write('error: no package specified (bun remove <package>)\n');
			return 1;
		}
		header(c, 'remove');
		return run('npm', ['uninstall', ...(global ? ['-g'] : []), ...pkgs], c);
	}

	async function update(c: CommandContext, args: string[]): Promise<number> {
		const latest = args.includes('--latest');
		const named = args.filter((a) => !a.startsWith('-'));
		const pkg = readPackageJson(c);
		if (!pkg) {
			c.stderr.write('error: no package.json in this directory\n');
			return 1;
		}
		const dev = pkg.devDependencies ?? {};
		const deps = pkg.dependencies ?? {};
		header(c, 'update');
		if (named.length === 0 && !latest) {
			// Within the ranges: drop the installed copies so npm resolves each one again.
			for (const name of [...Object.keys(deps), ...Object.keys(dev)]) {
				try { c.vfs.rmdirRecursive(join(c.cwd, 'node_modules', name)); } catch { /* not installed */ }
			}
			return run('npm', ['install'], c);
		}
		// Named packages (or every one with --latest) move to their latest version.
		const names = named.length > 0 ? named.map((s) => parsePackageSpec(s).name) : [...Object.keys(deps), ...Object.keys(dev)];
		const toLatest = (n: string) => `${n}@latest`;
		const devNames = names.filter((n) => dev[n] !== undefined);
		const prodNames = names.filter((n) => dev[n] === undefined);
		if (prodNames.length > 0) {
			const code = await run('npm', ['install', ...prodNames.map(toLatest)], c);
			if (code !== 0) return code;
		}
		if (devNames.length > 0) return run('npm', ['install', '-D', ...devNames.map(toLatest)], c);
		return 0;
	}

	// ── Running ──

	function findFile(c: CommandContext, target: string): string | null {
		const abs = resolve(c.cwd, target);
		const isFile = (p: string) => { try { return c.vfs.stat(p).type === 'file'; } catch { return false; } };
		if (isFile(abs)) return abs;
		// A path without its extension (bun ./index): the extensions Bun tries, in its order.
		if (/^\.{0,2}\//.test(target)) {
			for (const ext of ['.tsx', '.jsx', '.ts', '.mjs', '.js', '.mts', '.cjs', '.cts']) if (isFile(abs + ext)) return abs + ext;
		}
		return null;
	}

	async function runFile(c: CommandContext, file: string, args: string[], flags: RunFlags): Promise<number> {
		try {
			const src = c.vfs.readFileString(file);
			if (/\bBun\.[A-Za-z]|\bfrom\s*["']bun(?::[\w-]+)?["']|\brequire\(\s*["']bun(?::[\w-]+)?["']\s*\)/.test(src)) {
				c.stderr.write(`💡 ${basename(file)} uses Bun's own APIs (Bun.serve, bun:sqlite, ...), which a Lifo box doesn't have yet; it fails where it calls them.\n`);
			}
		} catch { /* node reports it */ }
		if (flags.watch) c.stderr.write('💡 --watch/--hot: not in a box yet; running once.\n');
		return run('node', [file, ...args], { ...c, env: envWithDotEnv(c, flags.envFiles) });
	}

	/** `bun run <target>` / `bun <target>`: a script, then a file, then a command from node_modules. */
	async function runTarget(c: CommandContext, target: string, args: string[], flags: RunFlags): Promise<number> {
		const pkg = readPackageJson(c);
		if (pkg?.scripts?.[target] !== undefined) {
			if (flags.watch) c.stderr.write('💡 --watch/--hot: not in a box yet; running once.\n');
			return runScriptWithHooks({ ...c, env: envWithDotEnv(c, flags.envFiles) }, pkg, target, args, shellExecute, registry, kernel, bunBanner);
		}
		const file = findFile(c, target);
		if (file) return runFile(c, file, args, flags);
		const bin = findLocalBinByName(c.vfs, c.cwd, target);
		if (bin) return run('node', [bin, ...args], { ...c, env: envWithDotEnv(c, flags.envFiles) });
		if (flags.ifPresent) return 0;
		c.stderr.write(`error: Script not found "${target}"\n`);
		return 1;
	}

	function listScripts(c: CommandContext): number {
		const scripts = readPackageJson(c)?.scripts ?? {};
		const names = Object.keys(scripts);
		c.stdout.write(`bun run v${BUN_VERSION} (lifo)\n\n`);
		if (names.length === 0) {
			c.stdout.write('No scripts in package.json. Run a file with: bun run ./index.ts\n');
			return 0;
		}
		c.stdout.write('package.json scripts:\n');
		for (const n of names) c.stdout.write(`  bun run ${n}\n    ${scripts[n]}\n`);
		return 0;
	}

	// ── Projects ──

	async function create(c: CommandContext, args: string[]): Promise<number> {
		const at = args.findIndex((a) => !a.startsWith('-'));
		const template = at === -1 ? undefined : args[at];
		if (!template) {
			c.stderr.write('Usage: bun create <template> [...args]   (e.g. bun create vite my-app)\n');
			return 1;
		}
		if (/^\.{0,2}\//.test(template) || /\.[jt]sx?$/.test(template)) {
			c.stderr.write(`bun create ${template}: scaffolding from a component file isn't available in a box yet.\n`);
			return 1;
		}
		if (!template.startsWith('@') && /^[\w.-]+\/[\w.-]+$/.test(template)) {
			c.stderr.write(`bun create ${template}: GitHub templates aren't available in a box yet. Clone it with git, then run bun install.\n`);
			return 1;
		}
		return bunx(c, [initializerPackage(template), ...args.slice(at + 1)]);
	}

	async function init(c: CommandContext, args: string[]): Promise<number> {
		const positional = args.filter((a) => !a.startsWith('-'));
		if (args.some((a) => a.startsWith('--react'))) {
			c.stderr.write("💡 bun init --react isn't available in a box yet; starting a blank project (bun create vite my-app --template react-ts gives you React).\n");
		}
		const dir = positional[0] ? resolve(c.cwd, positional[0]) : c.cwd;
		try { c.vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
		const at = { ...c, cwd: dir };
		const name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'project';
		const written: string[] = [];
		const write = (file: string, content: string, label = file) => {
			const path = join(dir, file);
			if (c.vfs.exists(path)) return;
			try { c.vfs.mkdir(dirname(path), { recursive: true }); } catch { /* exists */ }
			c.vfs.writeFile(path, content);
			written.push(label);
		};
		const existing = readPackageJson(at);
		const entry = typeof existing?.module === 'string' ? existing.module : (typeof existing?.main === 'string' ? existing.main : 'index.ts');
		write('package.json', JSON.stringify({
			name, module: 'index.ts', type: 'module', private: true,
			devDependencies: { '@types/bun': 'latest' },
			peerDependencies: { typescript: '^5' },
		}, null, 2) + '\n');
		write('.gitignore', GITIGNORE);
		write(entry, 'console.log("Hello via Bun!");\n');
		write('tsconfig.json', TSCONFIG, 'tsconfig.json (for editor autocomplete)');
		write('README.md', readme(name, entry));
		c.stdout.write(`bun init v${BUN_VERSION} (lifo)\n\n`);
		for (const f of written) c.stdout.write(` + ${f}\n`);
		if (written.length === 0) c.stdout.write(' (nothing to add: the project already has these files)\n');
		c.stdout.write(`\nTo get started, run:\n\n    ${dir === c.cwd ? '' : `cd ${positional[0]} && `}bun run ${entry}\n\n`);
		const code = await install(at, [], 'install');
		if (code !== 0) c.stderr.write('bun init: the project is ready, but installing its dependencies failed (run bun install to retry).\n');
		return 0;
	}

	async function pm(c: CommandContext, args: string[]): Promise<number> {
		const [sub, ...rest] = args;
		const global = rest.includes('-g') || rest.includes('--global');
		switch (sub) {
			case 'ls':
				return run('npm', ['ls', ...(global ? ['-g'] : [])], c);
			case 'bin':
				c.stdout.write((global ? '/usr/bin' : join(c.cwd, 'node_modules', '.bin')) + '\n');
				return 0;
			case 'cache':
				if (rest[0] === 'rm') {
					try { c.vfs.rmdirRecursive('/tmp/.npx-cache'); } catch { /* empty */ }
					c.stdout.write('Cleared the bunx cache\n');
					return 0;
				}
				c.stdout.write('/tmp/.npx-cache\n');
				return 0;
			case 'pack':
				return run('npm', ['pack'], c);
			default:
				c.stderr.write(`bun pm ${sub ?? ''}: in a box, bun pm has ls, bin, cache and pack.\n`);
				return 1;
		}
	}

	async function bunx(c: CommandContext, args: string[]): Promise<number> {
		const out: string[] = ['-y'];
		let i = 0;
		for (; i < args.length; i++) {
			const a = args[i];
			if (a === '-p' || a === '--package') { if (args[i + 1]) out.push('--package', args[++i]); }
			else if (a.startsWith('--package=')) out.push(a);
			else if (a === '-h' || a === '--help') { c.stdout.write(BUNX_USAGE); return 0; }
			else if (!a.startsWith('-')) break;
			// --bun, --silent, --verbose, --no-install: nothing to change in a box
		}
		if (i >= args.length) {
			c.stderr.write(BUNX_USAGE);
			return 1;
		}
		return run('npx', [...out, ...args.slice(i)], c);
	}

	const unavailable = (c: CommandContext, what: string, hint: string): number => {
		c.stderr.write(`bun ${what} isn't available in a Lifo box yet. ${hint}\n`);
		return 1;
	};

	return async (ctx) => {
		const { flags, rest } = parseRunFlags(ctx.args);
		const [sub, ...args] = rest;
		if (sub === '-v' || sub === '--version') { ctx.stdout.write(BUN_VERSION + '\n'); return 0; }
		if (sub === '--revision') { ctx.stdout.write(`${BUN_VERSION}+lifo\n`); return 0; }
		if ((!sub && flags.eval === undefined && flags.print === undefined) || sub === '-h' || sub === '--help' || sub === 'help') {
			ctx.stdout.write(USAGE);
			return 0;
		}
		const c: CommandContext = {
			...ctx,
			cwd: flags.cwd ? resolve(ctx.cwd, flags.cwd) : ctx.cwd,
			env: { ...ctx.env, npm_config_user_agent: BUN_USER_AGENT },
		};
		if (!noted.has(ctx.vfs)) {
			noted.add(ctx.vfs);
			ctx.stderr.write(NOTE);
		}
		if (flags.filter) return unavailable(c, '--filter', 'Run the command inside each workspace package instead.');
		if (flags.eval !== undefined || flags.print !== undefined) {
			const code = flags.print !== undefined ? `console.log(eval(${JSON.stringify(flags.print)}))` : flags.eval!;
			return run('node', ['-e', code, ...rest], { ...c, env: envWithDotEnv(c, flags.envFiles) });
		}

		switch (sub) {
			case 'install':
			case 'i':
				return install(c, args, args.some((a) => !a.startsWith('-')) ? 'add' : 'install');
			case 'add':
			case 'a':
				return install(c, args, 'add');
			case 'remove':
			case 'rm':
			case 'uninstall':
				return remove(c, args);
			case 'update':
				return update(c, args);
			case 'run': {
				const r = parseRunFlags(args, flags);
				const [target, ...targetArgs] = r.rest;
				return target ? runTarget(c, target, targetArgs, r.flags) : listScripts(c);
			}
			case 'x':
				return bunx(c, args);
			case 'create':
			case 'c':
				return create(c, args);
			case 'init':
				return init(c, args);
			case 'pm':
				return pm(c, args);
			case 'info':
				return run('npm', ['info', ...args], c);
			case 'exec':
				if (!shellExecute) return unavailable(c, 'exec', 'This box has no shell to run it in.');
				return shellExecute(args.join(' '), { ...c, env: envWithDotEnv(c, flags.envFiles) });
			case 'test':
				return unavailable(c, 'test', 'Run your tests with vitest or jest: bunx vitest');
			case 'build':
				return unavailable(c, 'build', "Bundle with your project's bundler (vite build), or bunx esbuild.");
			case 'repl':
				return unavailable(c, 'repl', 'Run code with bun -e "<code>", or a file with bun ./file.ts');
			case 'upgrade':
				c.stdout.write(`bun in a Lifo box is Lifo's mapping of Bun ${BUN_VERSION}'s CLI; there's nothing to upgrade.\n`);
				return 0;
			case 'link':
			case 'unlink':
			case 'publish':
			case 'patch':
			case 'patch-commit':
			case 'audit':
			case 'outdated':
			case 'why':
			case 'completions':
			case 'feedback':
				return unavailable(c, sub, 'See bun --help for what a box has.');
			default:
				return runTarget(c, sub, args, flags);
		}
	};
}

export function createBunxCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel): Command {
	const bun = createBunCommand(registry, shellExecute, kernel);
	return (ctx) => {
		if (ctx.args.length === 0 || ctx.args[0] === '-h' || ctx.args[0] === '--help') {
			(ctx.args.length === 0 ? ctx.stderr : ctx.stdout).write(BUNX_USAGE);
			return Promise.resolve(ctx.args.length === 0 ? 1 : 0);
		}
		return bun({ ...ctx, args: ['x', ...ctx.args] });
	};
}

const TSCONFIG = `{
  "compilerOptions": {
    // Environment setup & latest features
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,

    // Bundler mode
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,

    // Best practices
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // Some stricter flags (disabled by default)
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false
  }
}
`;

const GITIGNORE = `# dependencies (bun install)
node_modules

# output
out
dist
*.tgz

# code coverage
coverage
*.lcov

# logs
logs
*.log

# dotenv environment variable files
.env
.env.development.local
.env.test.local
.env.production.local
.env.local

# caches
.eslintcache
.cache
*.tsbuildinfo

# IntelliJ based IDEs
.idea

# Finder (MacOS) folder config
.DS_Store
`;

function readme(name: string, entry: string): string {
	return `# ${name}

To install dependencies:

\`\`\`bash
bun install
\`\`\`

To run:

\`\`\`bash
bun run ${entry}
\`\`\`

This project was created using \`bun init\` in a Lifo box, where bun runs on Lifo's npm and node.
`;
}
