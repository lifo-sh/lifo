import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { VFS } from '../../kernel/vfs/index.js';
import type { Kernel } from '../../kernel/index.js';
import { resolve, join } from '../../utils/path.js';
import { decompressGzip, parseTar } from '../../utils/archive.js';

const GLOBAL_MODULES = '/usr/lib/node_modules';
const GLOBAL_BIN = '/usr/bin';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const NPM_VERSION = '10.0.0';

// ─── Types ───

interface PackageJson {
	name?: string;
	version?: string;
	description?: string;
	main?: string;
	bin?: string | Record<string, string>;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	license?: string;
	author?: string | { name: string };
}

interface RegistryVersionInfo {
	name: string;
	version: string;
	description?: string;
	main?: string;
	bin?: string | Record<string, string>;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	dist: {
		tarball: string;
		shasum?: string;
		integrity?: string;
	};
}

export type ShellExecuteFn = (
	cmd: string,
	ctx: CommandContext,
) => Promise<number>;

// ─── Helpers ───

function getRegistry(env: Record<string, string>): string {
	return env.NPM_REGISTRY || DEFAULT_REGISTRY;
}

function parsePackageSpec(spec: string): { name: string; version: string | null } {
	// Scoped: @scope/name@version
	if (spec.startsWith('@')) {
		const slashIdx = spec.indexOf('/');
		if (slashIdx === -1) return { name: spec, version: null };
		const rest = spec.slice(slashIdx + 1);
		const atIdx = rest.lastIndexOf('@');
		if (atIdx > 0) {
			return {
				name: spec.slice(0, slashIdx + 1 + atIdx),
				version: rest.slice(atIdx + 1),
			};
		}
		return { name: spec, version: null };
	}

	// Regular: name@version
	const atIdx = spec.lastIndexOf('@');
	if (atIdx > 0) {
		return { name: spec.slice(0, atIdx), version: spec.slice(atIdx + 1) };
	}
	return { name: spec, version: null };
}

// ─── Semver helpers ───

function parseVersion(v: string): [number, number, number] | null {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
	if (a[0] !== b[0]) return a[0] - b[0];
	if (a[1] !== b[1]) return a[1] - b[1];
	return a[2] - b[2];
}

function isVersionRange(version: string): boolean {
	return /[\^~>=<|*x]/.test(version);
}

function satisfiesRange(version: string, range: string): boolean {
	const v = parseVersion(version);
	if (!v) return false;

	// Exact
	if (/^\d+\.\d+\.\d+$/.test(range)) {
		const r = parseVersion(range);
		return r !== null && v[0] === r[0] && v[1] === r[1] && v[2] === r[2];
	}

	// Caret ^X.Y.Z
	if (range.startsWith('^')) {
		const r = parseVersion(range.slice(1));
		if (!r) return false;
		if (r[0] > 0) return v[0] === r[0] && compareVersions(v, r) >= 0;
		if (r[1] > 0) return v[0] === 0 && v[1] === r[1] && compareVersions(v, r) >= 0;
		return v[0] === 0 && v[1] === 0 && v[2] === r[2];
	}

	// Tilde ~X.Y.Z
	if (range.startsWith('~')) {
		const r = parseVersion(range.slice(1));
		if (!r) return false;
		return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2];
	}

	// >=X.Y.Z
	if (range.startsWith('>=')) {
		const r = parseVersion(range.slice(2).trim());
		if (!r) return false;
		return compareVersions(v, r) >= 0;
	}

	// * or latest
	if (range === '*' || range === 'latest' || range === '') return true;

	return true; // unrecognised range - accept anything
}

// ─── Registry fetch ───

function encodePackageName(name: string): string {
	return name.startsWith('@')
		? '@' + encodeURIComponent(name.slice(1))
		: encodeURIComponent(name);
}

async function fetchPackageInfo(
	registry: string,
	name: string,
	version: string | null,
	signal: AbortSignal,
): Promise<RegistryVersionInfo> {
	// If version is a semver range, resolve it against all versions
	if (version && isVersionRange(version)) {
		return fetchWithRange(registry, name, version, signal);
	}

	// Exact version or dist-tag (or null → latest)
	const tag = version || 'latest';
	const url = `${registry}/${encodePackageName(name)}/${tag}`;

	const response = await fetch(url, { signal });
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Package '${name}${version ? '@' + version : ''}' not found in registry`);
		}
		throw new Error(`Registry returned ${response.status} ${response.statusText}`);
	}

	return await response.json();
}

async function fetchWithRange(
	registry: string,
	name: string,
	range: string,
	signal: AbortSignal,
): Promise<RegistryVersionInfo> {
	const url = `${registry}/${encodePackageName(name)}`;
	const response = await fetch(url, {
		signal,
		headers: { Accept: 'application/json' },
	});
	if (!response.ok) {
		throw new Error(`Package '${name}' not found in registry`);
	}

	const data = await response.json();
	const versions = Object.keys(data.versions || {});

	const matching = versions
		.filter((v) => satisfiesRange(v, range))
		.map((v) => ({ version: v, parsed: parseVersion(v)! }))
		.filter((v) => v.parsed !== null)
		.sort((a, b) => compareVersions(b.parsed, a.parsed)); // highest first

	if (matching.length === 0) {
		throw new Error(`No version of '${name}' satisfies '${range}'`);
	}

	return data.versions[matching[0].version];
}

async function downloadAndExtract(
	tarballUrl: string,
	targetDir: string,
	vfs: VFS,
	signal: AbortSignal,
): Promise<void> {
	const response = await fetch(tarballUrl, { signal });
	if (!response.ok) {
		throw new Error(`Failed to download tarball: ${response.status}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	const compressed = new Uint8Array(arrayBuffer);

	// Decompress gzip → parse tar
	const decompressed = await decompressGzip(compressed);
	const entries = parseTar(decompressed);

	// Ensure target directory
	try { vfs.mkdir(targetDir, { recursive: true }); } catch { /* exists */ }

	// Extract, stripping the first path component (npm tarballs use "package/")
	for (const entry of entries) {
		const slashIdx = entry.path.indexOf('/');
		if (slashIdx === -1) continue;

		const relativePath = entry.path.slice(slashIdx + 1);
		if (!relativePath) continue;

		const fullPath = join(targetDir, relativePath);

		if (entry.type === 'directory') {
			try { vfs.mkdir(fullPath, { recursive: true }); } catch { /* exists */ }
		} else {
			// Ensure parent exists
			const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
			if (parent) {
				try { vfs.mkdir(parent, { recursive: true }); } catch { /* exists */ }
			}
			vfs.writeFile(fullPath, entry.data);
		}
	}
}

function readProjectPackageJson(vfs: VFS, cwd: string): PackageJson | null {
	const pkgPath = join(cwd, 'package.json');
	try {
		return JSON.parse(vfs.readFileString(pkgPath));
	} catch {
		return null;
	}
}

function writeProjectPackageJson(vfs: VFS, cwd: string, pkg: PackageJson): void {
	const pkgPath = join(cwd, 'package.json');
	vfs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

export function getBinEntries(pkg: PackageJson): Record<string, string> {
	if (!pkg.bin) return {};
	if (typeof pkg.bin === 'string') {
		return { [pkg.name || 'unknown']: pkg.bin };
	}
	return pkg.bin;
}

export function registerBinCommand(registry: CommandRegistry, binName: string, scriptPath: string, kernel?: Kernel): void {
	registry.registerLazy(binName, () =>
		import('./node.js').then((mod) => ({
			default: ((ctx: CommandContext) => {
				// Use kernel's portRegistry if available, otherwise fall back to default
				const nodeCommand = kernel ? mod.createNodeCommand(kernel) : mod.default;
				return nodeCommand({
					...ctx,
					args: [scriptPath, ...ctx.args],
				});
			}) as Command,
		})),
	);
}


// ─── Install logic ───

async function installSinglePackage(
	name: string,
	version: string | null,
	targetBase: string,
	vfs: VFS,
	npmRegistry: string,
	signal: AbortSignal,
	stdout: CommandOutputStream,
	stderr: CommandOutputStream,
	isGlobal: boolean,
	registry: CommandRegistry,
	seen: Set<string>,
	kernel?: Kernel,
): Promise<number> {
	if (seen.has(name)) return 0;
	seen.add(name);

	const targetDir = join(targetBase, name);

	// Skip if already installed
	if (vfs.exists(join(targetDir, 'package.json'))) {
		return 0;
	}

	stdout.write(`  ${name}${version ? '@' + version : ''}...\n`);

	const info = await fetchPackageInfo(npmRegistry, name, version, signal);

	await downloadAndExtract(info.dist.tarball, targetDir, vfs, signal);

	let installed = 1;

	// Global install: link binaries
	if (isGlobal) {
		const binEntries = getBinEntries(info);
		for (const [binName, binPath] of Object.entries(binEntries)) {
			const scriptPath = resolve(targetDir, binPath);
			registerBinCommand(registry, binName, scriptPath, kernel);
			try { vfs.mkdir(GLOBAL_BIN, { recursive: true }); } catch { /* exists */ }
			vfs.writeFile(
				join(GLOBAL_BIN, binName),
				`#!/usr/bin/env node\nrequire('${scriptPath}');\n`,
			);
		}

	}

	// Recursively install dependencies (flat into the same targetBase)
	if (info.dependencies) {
		for (const [depName, depRange] of Object.entries(info.dependencies)) {
			try {
				installed += await installSinglePackage(
					depName, depRange, targetBase, vfs, npmRegistry, signal,
					stdout, stderr, isGlobal, registry, seen, kernel,
				);
			} catch (e) {
				stderr.write(`  warn: could not install ${depName}: ${e instanceof Error ? e.message : String(e)}\n`);
			}
		}
	}

	return installed;
}

// ─── Subcommands ───

function printHelp(ctx: CommandContext): void {
	ctx.stdout.write('Usage: npm <command> [args]\n\n');
	ctx.stdout.write('Commands:\n');
	ctx.stdout.write('  init [-y]                  create package.json\n');
	ctx.stdout.write('  install [pkg...] [-g] [-D] install packages\n');
	ctx.stdout.write('  uninstall <pkg> [-g]       remove a package\n');
	ctx.stdout.write('  list [-g]                  list installed packages\n');
	ctx.stdout.write('  run <script>               run a package.json script\n');
	ctx.stdout.write('  start                      run the "start" script\n');
	ctx.stdout.write('  test                       run the "test" script\n');
	ctx.stdout.write('  info <pkg>                 show package info from registry\n');
	ctx.stdout.write('  search <term>              search the npm registry\n');
	ctx.stdout.write('  -v, --version              print npm version\n');
}

async function npmInit(ctx: CommandContext): Promise<number> {
	const pkgPath = join(ctx.cwd, 'package.json');
	if (ctx.vfs.exists(pkgPath)) {
		ctx.stderr.write('package.json already exists\n');
		return 1;
	}

	const dirName = ctx.cwd.split('/').pop() || 'project';
	const pkg: PackageJson = {
		name: dirName,
		version: '1.0.0',
		description: '',
		main: 'index.js',
		scripts: {
			test: 'echo "Error: no test specified" && exit 1',
		},
		license: 'ISC',
	};

	writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg);
	ctx.stdout.write(`Wrote to ${pkgPath}:\n\n`);
	ctx.stdout.write(JSON.stringify(pkg, null, 2) + '\n');
	return 0;
}

async function npmInstall(ctx: CommandContext, registry: CommandRegistry, kernel?: Kernel): Promise<number> {
	const args = ctx.args.slice(1);

	let isGlobal = false;
	let saveDev = false;
	const packages: string[] = [];

	for (const arg of args) {
		if (arg === '-g' || arg === '--global') {
			isGlobal = true;
		} else if (arg === '-D' || arg === '--save-dev') {
			saveDev = true;
		} else if (arg === '--save' || arg === '-S') {
			// default, ignore
		} else if (!arg.startsWith('-')) {
			packages.push(arg);
		}
	}

	const npmRegistry = getRegistry(ctx.env);
	const startTime = Date.now();
	let installed = 0;

	const targetBase = isGlobal ? GLOBAL_MODULES : join(ctx.cwd, 'node_modules');

	// Ensure global dirs exist
	if (isGlobal) {
		try { ctx.vfs.mkdir(GLOBAL_MODULES, { recursive: true }); } catch { /* exists */ }
		try { ctx.vfs.mkdir(GLOBAL_BIN, { recursive: true }); } catch { /* exists */ }
	}

	if (packages.length === 0) {
		// Install from package.json
		if (isGlobal) {
			ctx.stderr.write('npm: install with no args cannot be used with -g\n');
			return 1;
		}

		const pkg = readProjectPackageJson(ctx.vfs, ctx.cwd);
		if (!pkg) {
			ctx.stderr.write('npm ERR! no package.json found in this directory\n');
			return 1;
		}

		const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
		const depNames = Object.keys(allDeps);

		if (depNames.length === 0) {
			ctx.stdout.write('up to date, audited 0 packages\n');
			return 0;
		}

		ctx.stdout.write('Installing dependencies...\n');
		const seen = new Set<string>();
		for (const [name, range] of Object.entries(allDeps)) {
			try {
				installed += await installSinglePackage(
					name, range, targetBase, ctx.vfs, npmRegistry, ctx.signal,
					ctx.stdout, ctx.stderr, false, registry, seen, kernel,
				);
			} catch (e) {
				ctx.stderr.write(`npm ERR! ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
			}
		}
	} else {
		// Install specified packages
		ctx.stdout.write('Installing packages...\n');
		const seen = new Set<string>();
		for (const spec of packages) {
			const { name, version } = parsePackageSpec(spec);
			try {
				installed += await installSinglePackage(
					name, version, targetBase, ctx.vfs, npmRegistry, ctx.signal,
					ctx.stdout, ctx.stderr, isGlobal, registry, seen,
				);

				// Update package.json for local installs
				if (!isGlobal) {
					const pkg = readProjectPackageJson(ctx.vfs, ctx.cwd);
					if (pkg) {
						const installedPkgPath = join(targetBase, name, 'package.json');
						let versionStr = 'latest';
						try {
							const ipkg = JSON.parse(ctx.vfs.readFileString(installedPkgPath));
							versionStr = '^' + ipkg.version;
						} catch { /* ignore */ }

						if (saveDev) {
							pkg.devDependencies = pkg.devDependencies || {};
							pkg.devDependencies[name] = versionStr;
						} else {
							pkg.dependencies = pkg.dependencies || {};
							pkg.dependencies[name] = versionStr;
						}
						writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg);
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
					ctx.stderr.write(`npm ERR! network error fetching ${name}\n`);
					ctx.stderr.write(`This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n`);
				} else {
					ctx.stderr.write(`npm ERR! ${msg}\n`);
				}
				return 1;
			}
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	ctx.stdout.write(`\nadded ${installed} package${installed !== 1 ? 's' : ''} in ${elapsed}s\n`);
	return 0;
}

async function npmUninstall(ctx: CommandContext, _registry: CommandRegistry): Promise<number> {
	const args = ctx.args.slice(1);
	let isGlobal = false;
	const packages: string[] = [];

	for (const arg of args) {
		if (arg === '-g' || arg === '--global') {
			isGlobal = true;
		} else if (!arg.startsWith('-')) {
			packages.push(arg);
		}
	}

	if (packages.length === 0) {
		ctx.stderr.write('npm uninstall requires at least one package name\n');
		return 1;
	}

	const targetBase = isGlobal ? GLOBAL_MODULES : join(ctx.cwd, 'node_modules');

	for (const name of packages) {
		const targetDir = join(targetBase, name);

		if (!ctx.vfs.exists(targetDir)) {
			ctx.stderr.write(`npm warn: ${name} is not installed\n`);
			continue;
		}

		// Unlink global binaries
		if (isGlobal) {
			try {
				const pkg: PackageJson = JSON.parse(ctx.vfs.readFileString(join(targetDir, 'package.json')));
				for (const binName of Object.keys(getBinEntries(pkg))) {
					try { ctx.vfs.unlink(join(GLOBAL_BIN, binName)); } catch { /* ignore */ }
				}
			} catch { /* ignore */ }
		}

		// Remove the package
		try {
			ctx.vfs.rmdirRecursive(targetDir);
		} catch (e) {
			ctx.stderr.write(`npm ERR! could not remove ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
			return 1;
		}

		// Update package.json for local uninstalls
		if (!isGlobal) {
			const pkg = readProjectPackageJson(ctx.vfs, ctx.cwd);
			if (pkg) {
				if (pkg.dependencies) delete pkg.dependencies[name];
				if (pkg.devDependencies) delete pkg.devDependencies[name];
				writeProjectPackageJson(ctx.vfs, ctx.cwd, pkg);
			}
		}

		ctx.stdout.write(`removed ${name}\n`);
	}

	return 0;
}

async function npmList(ctx: CommandContext): Promise<number> {
	const args = ctx.args.slice(1);
	const isGlobal = args.includes('-g') || args.includes('--global');

	const modulesDir = isGlobal ? GLOBAL_MODULES : join(ctx.cwd, 'node_modules');
	const header = isGlobal
		? '/usr/lib'
		: (readProjectPackageJson(ctx.vfs, ctx.cwd)?.name || ctx.cwd);

	ctx.stdout.write(`${header}\n`);

	if (!ctx.vfs.exists(modulesDir)) {
		ctx.stdout.write('└── (empty)\n');
		return 0;
	}

	const entries = ctx.vfs.readdir(modulesDir);
	const packages: { name: string; version: string }[] = [];

	for (const entry of entries) {
		if (entry.type !== 'directory') continue;

		if (entry.name.startsWith('@')) {
			// Scoped packages
			try {
				const scopeEntries = ctx.vfs.readdir(join(modulesDir, entry.name));
				for (const se of scopeEntries) {
					if (se.type !== 'directory') continue;
					const v = readPkgVersion(ctx.vfs, join(modulesDir, entry.name, se.name));
					packages.push({ name: `${entry.name}/${se.name}`, version: v });
				}
			} catch { /* ignore */ }
		} else {
			const v = readPkgVersion(ctx.vfs, join(modulesDir, entry.name));
			packages.push({ name: entry.name, version: v });
		}
	}

	if (packages.length === 0) {
		ctx.stdout.write('└── (empty)\n');
	} else {
		for (let i = 0; i < packages.length; i++) {
			const p = packages[i];
			const last = i === packages.length - 1;
			ctx.stdout.write(`${last ? '└── ' : '├── '}${p.name}@${p.version}\n`);
		}
	}

	return 0;
}

function readPkgVersion(vfs: VFS, pkgDir: string): string {
	try {
		const pkg = JSON.parse(vfs.readFileString(join(pkgDir, 'package.json')));
		return pkg.version || '?';
	} catch {
		return '?';
	}
}

async function npmRun(ctx: CommandContext, shellExecute?: ShellExecuteFn, registry?: CommandRegistry, kernel?: Kernel): Promise<number> {
	const args = ctx.args.slice(1);
	const scriptName = args[0];

	const pkg = readProjectPackageJson(ctx.vfs, ctx.cwd);
	if (!pkg) {
		ctx.stderr.write('npm ERR! no package.json found\n');
		return 1;
	}

	if (!scriptName) {
		// List available scripts
		if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
			ctx.stdout.write('No scripts defined in package.json\n');
			return 0;
		}
		ctx.stdout.write('Available scripts:\n');
		for (const [name, cmd] of Object.entries(pkg.scripts)) {
			ctx.stdout.write(`  ${name}\n    ${cmd}\n`);
		}
		return 0;
	}

	if (!pkg.scripts || !pkg.scripts[scriptName]) {
		ctx.stderr.write(`npm ERR! Missing script: "${scriptName}"\n`);
		if (pkg.scripts) {
			ctx.stderr.write('\nAvailable scripts:\n');
			for (const name of Object.keys(pkg.scripts)) {
				ctx.stderr.write(`  - ${name}\n`);
			}
		}
		return 1;
	}

	const script = pkg.scripts[scriptName];
	ctx.stdout.write(`\n> ${pkg.name || ''}@${pkg.version || '1.0.0'} ${scriptName}\n`);
	ctx.stdout.write(`> ${script}\n\n`);

	// Register local bin scripts from node_modules so they're available in scripts
	if (registry) {
		const nmDir = join(ctx.cwd, 'node_modules');
		ctx.stderr.write(`[npm:debug] cwd="${ctx.cwd}", nmDir="${nmDir}", exists=${ctx.vfs.exists(nmDir)}\n`);
		if (ctx.vfs.exists(nmDir)) {
			try {
				const entries = ctx.vfs.readdir(nmDir);
				ctx.stderr.write(`[npm:debug] node_modules entries (${entries.length}): ${entries.slice(0, 20).join(', ')}\n`);
				// Check vite specifically
				const vitePkg = join(nmDir, 'vite', 'package.json');
				if (ctx.vfs.exists(vitePkg)) {
					const vPkg = JSON.parse(ctx.vfs.readFileString(vitePkg));
					ctx.stderr.write(`[npm:debug] vite pkg.bin=${JSON.stringify(vPkg.bin)}\n`);
				} else {
					ctx.stderr.write(`[npm:debug] vite/package.json not found at ${vitePkg}\n`);
				}
			} catch (e) { ctx.stderr.write(`[npm:debug] readdir error: ${e}\n`); }
		}
		const count = registerLocalBins(ctx.vfs, ctx.cwd, registry, kernel);
		ctx.stderr.write(`[npm:debug] registered ${count} local bins, script="${script}"\n`);
		const firstWord = script.trim().split(/\s+/)[0];
		ctx.stderr.write(`[npm:debug] first command: "${firstWord}", has=${registry.has(firstWord)}\n`);
	}

	// For simple scripts (single command, no shell operators), invoke directly
	// to avoid extra stack frames from shell.execute → interpreter chain
	if (registry) {
		const trimmed = script.trim();
		const hasShellSyntax = /[;&|`$(){}]/.test(trimmed);
		if (!hasShellSyntax) {
			const parts = trimmed.split(/\s+/);
			const cmdName = parts[0];
			const cmdArgs = parts.slice(1);
			const cmd = await registry.resolve(cmdName);
			if (cmd) {
				return cmd({ ...ctx, args: cmdArgs });
			}
		}
	}

	if (shellExecute) {
		return shellExecute(script, ctx);
	}

	// No shell access - print the command for the user
	ctx.stderr.write('(shell integration unavailable, run the command directly)\n');
	return 1;
}

/** Scan node_modules for packages with bin entries and register them as commands */
function registerLocalBins(vfs: VFS, cwd: string, registry: CommandRegistry, kernel?: Kernel): number {
	const nmDir = join(cwd, 'node_modules');
	if (!vfs.exists(nmDir)) return 0;

	let count = 0;
	try {
		const entries = vfs.readdir(nmDir);
		for (const dirent of entries) {
			const name = dirent.name;
			if (name.startsWith('.')) continue;

			if (name.startsWith('@')) {
				// Scoped packages: read @scope/pkg
				const scopeDir = join(nmDir, name);
				try {
					const scopeEntries = vfs.readdir(scopeDir);
					for (const scopeEntry of scopeEntries) {
						count += registerPkgBins(vfs, join(scopeDir, scopeEntry.name), registry, kernel);
					}
				} catch { /* ignore */ }
			} else {
				count += registerPkgBins(vfs, join(nmDir, name), registry, kernel);
			}
		}
	} catch { /* ignore */ }
	return count;
}

function registerPkgBins(vfs: VFS, pkgDir: string, registry: CommandRegistry, kernel?: Kernel): number {
	const pkgJsonPath = join(pkgDir, 'package.json');
	if (!vfs.exists(pkgJsonPath)) return 0;
	let count = 0;
	try {
		const pkg: PackageJson = JSON.parse(vfs.readFileString(pkgJsonPath));
		const bins = getBinEntries(pkg);
		for (const [binName, binPath] of Object.entries(bins)) {
			// Only register if not already in registry
			if (!registry.has(binName)) {
				const scriptPath = resolve(pkgDir, binPath);
				registerBinCommand(registry, binName, scriptPath, kernel);
				count++;
			}
		}
	} catch { /* ignore */ }
	return count;
}

async function npmInfo(ctx: CommandContext): Promise<number> {
	const args = ctx.args.slice(1);
	const spec = args[0];

	if (!spec) {
		ctx.stderr.write('Usage: npm info <package>\n');
		return 1;
	}

	const { name, version } = parsePackageSpec(spec);
	const npmRegistry = getRegistry(ctx.env);

	try {
		const info = await fetchPackageInfo(npmRegistry, name, version, ctx.signal);
		ctx.stdout.write(`\n${info.name}@${info.version}\n`);
		if (info.description) ctx.stdout.write(`${info.description}\n`);
		ctx.stdout.write('\n');
		if (info.main) ctx.stdout.write(`main: ${info.main}\n`);

		const binEntries = getBinEntries(info);
		if (Object.keys(binEntries).length > 0) {
			ctx.stdout.write(`bin: ${Object.keys(binEntries).join(', ')}\n`);
		}

		if (info.dependencies) {
			const deps = Object.keys(info.dependencies);
			ctx.stdout.write(`\ndependencies (${deps.length}):\n`);
			for (const dep of deps) {
				ctx.stdout.write(`  ${dep}: ${info.dependencies[dep]}\n`);
			}
		}

		ctx.stdout.write(`\ntarball: ${info.dist.tarball}\n`);
		if (info.dist.shasum) ctx.stdout.write(`shasum: ${info.dist.shasum}\n`);
		if (info.dist.integrity) ctx.stdout.write(`integrity: ${info.dist.integrity}\n`);
	} catch (e) {
		ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
		return 1;
	}

	return 0;
}

async function npmSearch(ctx: CommandContext): Promise<number> {
	const args = ctx.args.slice(1);
	const term = args.join(' ');

	if (!term) {
		ctx.stderr.write('Usage: npm search <term>\n');
		return 1;
	}

	const npmRegistry = getRegistry(ctx.env);
	const url = `${npmRegistry}/-/v1/search?text=${encodeURIComponent(term)}&size=10`;

	try {
		const response = await fetch(url, { signal: ctx.signal });
		if (!response.ok) {
			throw new Error(`Registry returned ${response.status}`);
		}

		const data = await response.json();
		const results = data.objects as Array<{
			package: { name: string; version: string; description?: string };
		}>;

		if (!results || results.length === 0) {
			ctx.stdout.write('No results found\n');
			return 0;
		}

		// Header
		ctx.stdout.write('NAME'.padEnd(30) + 'VERSION'.padEnd(12) + 'DESCRIPTION\n');
		ctx.stdout.write('-'.repeat(70) + '\n');

		for (const r of results) {
			const p = r.package;
			const name = p.name.length > 28 ? p.name.slice(0, 28) + '..' : p.name;
			const desc = (p.description || '').slice(0, 40);
			ctx.stdout.write(`${name.padEnd(30)}${p.version.padEnd(12)}${desc}\n`);
		}
	} catch (e) {
		ctx.stderr.write(`npm ERR! ${e instanceof Error ? e.message : String(e)}\n`);
		return 1;
	}

	return 0;
}

// ─── Factory ───

export function createNpmCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel): Command {
	return async (ctx) => {
		const subcommand = ctx.args[0];

		if (!subcommand || subcommand === '--help' || subcommand === '-h') {
			printHelp(ctx);
			return subcommand ? 0 : 1;
		}

		switch (subcommand) {
			case 'init':
				return npmInit(ctx);
			case 'install':
			case 'i':
			case 'add':
				return npmInstall(ctx, registry, kernel);
			case 'uninstall':
			case 'remove':
			case 'rm':
			case 'un':
				return npmUninstall(ctx, registry);
			case 'list':
			case 'ls':
				return npmList(ctx);
			case 'run':
			case 'run-script':
				return npmRun(ctx, shellExecute, registry, kernel);
			case 'start':
				return npmRun({ ...ctx, args: ['run', 'start', ...ctx.args.slice(1)] }, shellExecute, registry);
			case 'test':
				return npmRun({ ...ctx, args: ['run', 'test', ...ctx.args.slice(1)] }, shellExecute, registry);
			case 'info':
			case 'view':
			case 'show':
				return npmInfo(ctx);
			case 'search':
				return npmSearch(ctx);
			case '-v':
			case '--version':
				ctx.stdout.write(NPM_VERSION + '\n');
				return 0;
			default:
				ctx.stderr.write(`npm: unknown command '${subcommand}'\n`);
				ctx.stderr.write('Run npm --help for usage\n');
				return 1;
		}
	};
}

/**
 * Install a single npm package globally into the VFS.
 *
 * Called directly by `lifo install` to avoid the shell.execute()
 * round-trip which can silently swallow output and errors.
 */
// ─── npx ───

const NPX_CACHE = '/tmp/.npx-cache/node_modules';

function findBinScript(
	vfs: VFS,
	pkgDir: string,
	binName: string | null,
): string | null {
	const pkgJsonPath = join(pkgDir, 'package.json');
	if (!vfs.exists(pkgJsonPath)) return null;
	try {
		const pkg: PackageJson = JSON.parse(vfs.readFileString(pkgJsonPath));
		const bins = getBinEntries(pkg);
		if (Object.keys(bins).length === 0) return null;
		// If a specific bin name is requested, look for it
		if (binName && bins[binName]) return resolve(pkgDir, bins[binName]);
		// Otherwise return the first entry
		const first = Object.values(bins)[0];
		return first ? resolve(pkgDir, first) : null;
	} catch {
		return null;
	}
}

export function createNpxCommand(
	registry: CommandRegistry,
	shellExecute?: ShellExecuteFn,
): Command {
	return async (ctx) => {
		const rawArgs = ctx.args.slice();
		let explicitPkg: string | null = null;

		// Parse flags
		const passthrough: string[] = [];
		let i = 0;
		while (i < rawArgs.length) {
			const a = rawArgs[i];
			if (a === '-y' || a === '--yes') {
				i++;
				continue;
			}
			if (a === '--package' && i + 1 < rawArgs.length) {
				explicitPkg = rawArgs[i + 1];
				i += 2;
				continue;
			}
			if (a.startsWith('--package=')) {
				explicitPkg = a.slice('--package='.length);
				i++;
				continue;
			}
			if (a === '--version' || a === '-v') {
				ctx.stdout.write(NPM_VERSION + '\n');
				return 0;
			}
			if (a === '--help' || a === '-h') {
				ctx.stdout.write('Usage: npx [options] <package[@version]> [args...]\n\n');
				ctx.stdout.write('Options:\n');
				ctx.stdout.write('  -y, --yes              skip prompts\n');
				ctx.stdout.write('  --package=<pkg>        explicit package name\n');
				ctx.stdout.write('  -v, --version          print version\n');
				ctx.stdout.write('  -h, --help             show this help\n');
				return 0;
			}
			// First non-flag is the package spec (or bin name if --package was set)
			break;
		}

		const spec = rawArgs[i];
		if (!spec) {
			ctx.stderr.write('npx: missing package or command\n');
			ctx.stderr.write('Usage: npx <package[@version]> [args...]\n');
			return 1;
		}
		// Everything after the spec is passthrough args
		passthrough.push(...rawArgs.slice(i + 1));

		const { name: parsedName, version } = parsePackageSpec(explicitPkg || spec);
		// The bin name to look for: if --package was used, spec is the bin name; otherwise derive from package name
		const binName = explicitPkg ? spec : parsedName.split('/').pop()!;

		// 1. Check local node_modules
		const localPkgDir = join(ctx.cwd, 'node_modules', parsedName);
		let scriptPath = findBinScript(ctx.vfs, localPkgDir, binName);

		// 2. Check global modules
		if (!scriptPath) {
			const globalPkgDir = join(GLOBAL_MODULES, parsedName);
			scriptPath = findBinScript(ctx.vfs, globalPkgDir, binName);
		}

		// 3. Install to cache
		if (!scriptPath) {
			const cacheDir = join(NPX_CACHE, parsedName);
			if (!ctx.vfs.exists(join(cacheDir, 'package.json'))) {
				const npmRegistry = getRegistry(ctx.env);
				const seen = new Set<string>();
				try {
					await installSinglePackage(
						parsedName, version, NPX_CACHE, ctx.vfs, npmRegistry, ctx.signal,
						ctx.stdout, ctx.stderr, false, registry, seen,
					);
				} catch (e) {
					ctx.stderr.write(`npx: could not install ${parsedName}: ${e instanceof Error ? e.message : String(e)}\n`);
					return 1;
				}
			}
			scriptPath = findBinScript(ctx.vfs, cacheDir, binName);
		}

		if (!scriptPath) {
			ctx.stderr.write(`npx: could not find executable for '${binName}'\n`);
			return 1;
		}

		// 4. Execute via node (prefer direct invocation to avoid shell reentrance)
		const nodeCmd = await registry.resolve('node');
		if (nodeCmd) {
			return nodeCmd({ ...ctx, args: [scriptPath, ...passthrough] });
		}

		// Fallback: shellExecute
		if (shellExecute) {
			const cmd = ['node', scriptPath, ...passthrough]
				.map((s) => (s.includes(' ') ? `"${s}"` : s))
				.join(' ');
			return shellExecute(cmd, ctx);
		}

		ctx.stderr.write('npx: node command not available\n');
		return 1;
	};
}

export async function npmInstallGlobal(
	packageName: string,
	ctx: CommandContext,
	registry: CommandRegistry,
): Promise<number> {
	const npmRegistry = getRegistry(ctx.env);
	const startTime = Date.now();
	const seen = new Set<string>();

	try { ctx.vfs.mkdir(GLOBAL_MODULES, { recursive: true }); } catch { /* exists */ }
	try { ctx.vfs.mkdir(GLOBAL_BIN, { recursive: true }); } catch { /* exists */ }

	try {
		const installed = await installSinglePackage(
			packageName, null, GLOBAL_MODULES, ctx.vfs, npmRegistry, ctx.signal,
			ctx.stdout, ctx.stderr, true, registry, seen, kernel,
		);

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		ctx.stdout.write(`\nadded ${installed} package${installed !== 1 ? 's' : ''} in ${elapsed}s\n`);
		return 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
			ctx.stderr.write(`npm ERR! network error fetching ${packageName}\n`);
			ctx.stderr.write('This may be a CORS restriction. Try: export NPM_REGISTRY=<proxy-url>\n');
		} else {
			ctx.stderr.write(`npm ERR! ${msg}\n`);
		}
		return 1;
	}
}
