/**
 * expo — the Expo CLI commands that make sense in a box, run the Lifo way.
 *
 * The real Expo CLI runs Metro, which is too heavy for a tab. browser-metro (from
 * reactnative-run, whose `rnrun` CLI is the same drop-in for a real machine) bundles an Expo app
 * in the box instead, so the commands people and agents type keep working:
 *
 *   expo start [dir] [--port N]     → browser-metro [dir] --port N   (also `npx expo start`,
 *                                     and `npm start` with "start": "expo start")
 *   expo install <pkgs...>          → npm install <pkgs...>
 *
 * Each run says what it's doing on stderr, so nobody mistakes it for the Expo CLI.
 */

import type { Command } from '../types.js';

const NOTE = '💡 expo → browser-metro: an Expo-compatible bundler that runs in this box (Metro needs a real machine; there, try rnrun).\n';

const USAGE = `Usage: expo <command>

In a Lifo box, expo runs browser-metro (Expo-compatible, no Metro, no node_modules needed):

  expo start [dir] [--port <n>]   bundle the app and serve it (default port 8081)
  expo install <pkg...>           npm install <pkg...>

Other Expo CLI commands (prebuild, export, run:ios, login, ...) need the real Expo CLI on your
machine; rnrun (npx rnrun start) is a light drop-in for \`expo start\` there.
`;

// Flags `expo start` takes that browser-metro has no use for; dropped quietly.
const IGNORED = new Set(['--web', '-w', '--clear', '-c', '--lan', '--localhost', '--tunnel', '--offline', '--dev-client', '--go', '--ios', '-i', '--android', '-a', '--https']);

export function createExpoCommand(run: (name: string, args: string[], ctx: Parameters<Command>[0]) => Promise<number>): Command {
	return async (ctx) => {
		const [sub = 'start', ...rest] = ctx.args;
		if (sub === '--help' || sub === '-h' || sub === 'help') {
			ctx.stdout.write(USAGE);
			return 0;
		}
		// `expo`, `expo start ...`, `expo --port 8082`, or `expo <project dir>` all start the app.
		const isDir = !sub.startsWith('-') && ctx.vfs.exists(sub.startsWith('/') ? sub : `${ctx.cwd}/${sub}`);
		if (sub === 'start' || sub.startsWith('-') || (sub !== 'install' && isDir)) {
			const args = sub === 'start' ? rest : [sub, ...rest];
			ctx.stderr.write(NOTE);
			const out: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a === '--port' || a === '-p') {
					if (args[i + 1]) out.push('--port', args[++i]);
				} else if (a.startsWith('--port=')) out.push('--port', a.slice(7));
				else if (!IGNORED.has(a)) out.push(a);
			}
			return run('browser-metro', out, ctx);
		}
		if (sub === 'install') {
			ctx.stderr.write('💡 expo install → npm install (no SDK version pinning in a box)\n');
			return run('npm', ['install', ...rest], ctx);
		}
		ctx.stderr.write(`expo ${sub}: not available in a Lifo box.\n\n${USAGE}`);
		return 1;
	};
}
