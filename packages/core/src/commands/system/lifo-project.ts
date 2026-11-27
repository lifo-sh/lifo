/**
 * `lifo plan`, `lifo dev`, `lifo build`, `lifo start`: run a project the same way in a tab, in
 * lifo-sh on a laptop and on Lifo Cloud, from one plan (src/project).
 *
 *   lifo plan [dir] [--prod] [--json]   what would run, and why
 *   lifo dev [dir]                      install if needed, then the dev command
 *   lifo build [dir]                    install if needed, then the production build
 *   lifo start [dir]                    the production start (after lifo build)
 */

import type { CommandContext } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { ShellExecuteFn } from './npm.js';
import { describeNeeds, formatPlan, joinPath, NEED_COMMANDS, planProject, type ProjectMode, type ProjectNeed, type ProjectPlan } from '../../project/index.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** How to get a toolchain Lifo has as a package, when it isn't installed. */
const NEED_HINTS: Record<string, string> = {
	python: 'lifo install python',
};

export const PROJECT_USAGE = `Usage: lifo <plan|dev|build|start> [dir] [options]

Run a project from its package.json, Dockerfile and lifo.json, the same way in a tab, in lifo-sh
and on Lifo Cloud.

  lifo plan [dir] [--prod] [--json]   what would run, and why (dev plan unless --prod)
  lifo dev [dir]                      install if needed, then the dev command
  lifo build [dir]                    install if needed, then the production build
  lifo start [dir]                    the production start (run lifo build first)

Options:
  --install        install even when dependencies look installed
  --port <n>       the port to tell the app (PORT), instead of the plan's
  -n, --dry-run    print the commands instead of running them

Set any part in lifo.json: { "install", "build", "start", "dev", "port", "env" }.
`;

interface Parsed {
	dir: string;
	mode: ProjectMode | null;
	json: boolean;
	dryRun: boolean;
	forceInstall: boolean;
	port: number | null;
	error?: string;
}

function parse(ctx: CommandContext): Parsed {
	const out: Parsed = { dir: ctx.cwd, mode: null, json: false, dryRun: false, forceInstall: false, port: null };
	const args = ctx.args.slice(1);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === '--prod' || a === '--production') out.mode = 'prod';
		else if (a === '--dev') out.mode = 'dev';
		else if (a === '--json') out.json = true;
		else if (a === '-n' || a === '--dry-run') out.dryRun = true;
		else if (a === '--install') out.forceInstall = true;
		else if (a === '--port' || a.startsWith('--port=')) {
			const v = a === '--port' ? args[++i] : a.slice(7);
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1 || n > 65535) out.error = '--port must be 1-65535';
			else out.port = n;
		} else if (a.startsWith('-')) out.error = `unknown option ${a}`;
		else out.dir = joinPath(ctx.cwd, a);
	}
	return out;
}

/** The plan for the project in `dir`, read from this box's files. */
export function planHere(ctx: CommandContext, dir: string, mode: ProjectMode): ProjectPlan {
	return planProject(ctx.vfs, dir, { mode });
}

/** Needs this box can't meet: a toolchain whose command doesn't resolve here. */
export async function missingHere(plan: ProjectPlan, registry: CommandRegistry): Promise<ProjectNeed[]> {
	const out: ProjectNeed[] = [];
	for (const n of plan.needs) if (!(await registry.resolve(NEED_COMMANDS[n.name] ?? n.name))) out.push(n);
	return out;
}

export function needsMessage(missing: ProjectNeed[]): string {
	const hints = missing.map((n) => NEED_HINTS[n.name]).filter(Boolean);
	const unsupported = missing.filter((n) => !NEED_HINTS[n.name]);
	let msg = `This project needs ${describeNeeds(missing)}`;
	if (unsupported.length) msg += `, which ${unsupported.length === 1 ? "isn't" : "aren't"} in Lifo yet`;
	msg += '.';
	if (hints.length) msg += ` Install with: ${hints.join(' && ')}`;
	return msg;
}

export async function lifoProjectCommand(sub: 'plan' | 'dev' | 'build' | 'start', ctx: CommandContext, registry: CommandRegistry, shellExecute?: ShellExecuteFn): Promise<number> {
	if (ctx.args.includes('--help') || ctx.args.includes('-h')) {
		ctx.stdout.write(PROJECT_USAGE);
		return 0;
	}
	const p = parse(ctx);
	if (p.error) {
		ctx.stderr.write(`lifo ${sub}: ${p.error}\n`);
		return 1;
	}
	if (!ctx.vfs.exists(p.dir)) {
		ctx.stderr.write(`lifo ${sub}: ${p.dir}: no such directory\n`);
		return 1;
	}
	const mode: ProjectMode = sub === 'plan' ? (p.mode ?? 'dev') : sub === 'dev' ? 'dev' : 'prod';
	const plan = planHere(ctx, p.dir, mode);

	if (sub === 'plan') {
		if (p.json) ctx.stdout.write(JSON.stringify(plan, null, 2) + '\n');
		else ctx.stdout.write(formatPlan(plan));
		return 0;
	}

	if (!plan.sources.length) {
		ctx.stderr.write(`lifo ${sub}: no project in ${p.dir} (no package.json, Dockerfile or lifo.json)\n`);
		return 1;
	}
	const missing = await missingHere(plan, registry);
	if (missing.length) {
		ctx.stderr.write(`lifo ${sub}: ${needsMessage(missing)}\n`);
		return 1;
	}
	for (const s of plan.skipped) ctx.stderr.write(`${DIM}lifo: left out ${s.what}: ${s.why}${RESET}\n`);

	const run = async (cmd: string, env: Record<string, string>): Promise<number> => {
		ctx.stdout.write(`${DIM}$ ${cmd}${RESET}\n`);
		if (p.dryRun) return 0;
		if (!shellExecute) {
			ctx.stderr.write(`lifo ${sub}: this box can't run commands from lifo (no shell)\n`);
			return 1;
		}
		return shellExecute(cmd, { ...ctx, cwd: plan.dir, env: { ...ctx.env, ...env } });
	};

	const installed = !!plan.installedWhen && ctx.vfs.exists(joinPath(plan.dir, plan.installedWhen));
	if ((sub === 'dev' || sub === 'build') && plan.install && (p.forceInstall || !installed)) {
		const code = await run(plan.install, {});
		if (code !== 0) {
			ctx.stderr.write(`lifo ${sub}: install failed (exit ${code})\n`);
			return code;
		}
	}

	if (sub === 'build' || (sub === 'dev' && plan.build.length)) {
		if (!plan.build.length) {
			ctx.stdout.write(`Nothing to build: ${plan.sources.join(', ')} ${plan.sources.length === 1 ? 'has' : 'have'} no build step.\n`);
			return 0;
		}
		for (const step of plan.build) {
			const code = await run(step, plan.buildEnv);
			if (code !== 0) {
				ctx.stderr.write(`lifo ${sub}: build step failed (exit ${code}): ${step}\n`);
				return code;
			}
			if (ctx.signal.aborted) return 130;
		}
		if (sub === 'build') {
			ctx.stdout.write(`\nBuilt. Start it with: lifo start${p.dir === ctx.cwd ? '' : ` ${p.dir}`}\n`);
			return 0;
		}
	}

	if (!plan.start) {
		ctx.stderr.write(`lifo ${sub}: no ${mode === 'dev' ? 'dev command' : 'start command'} for this project. Set "${mode === 'dev' ? 'dev' : 'start'}" in lifo.json.\n`);
		return 1;
	}
	const port = p.port ?? plan.port;
	const env = { ...plan.env, ...(p.port || (port && !ctx.env.PORT) ? { PORT: String(port) } : {}) };
	if (port && !p.dryRun) ctx.stdout.write(`${DIM}(port ${port})${RESET}\n`);
	return run(plan.start, env);
}
