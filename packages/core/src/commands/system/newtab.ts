import type { Command } from '../types.js';

/**
 * newtab - Add a new tab to the current session
 * Usage: newtab [label]
 * Note: Only works in browser environments with window.addHttpTab exposed
 */
export function createNewtabCommand(): Command {
	return async (ctx) => {
		// Check if we're in a browser environment with the addHttpTab function
		if (typeof window === 'undefined' || !(window as any).addHttpTab) {
			ctx.stderr.write('newtab: not available in this environment\n');
			ctx.stderr.write('This command only works in the HTTP server tab playground\n');
			return 1;
		}

		const label = ctx.args.join(' ') || undefined;

		try {
			await (window as any).addHttpTab(label);
			ctx.stdout.write(`New tab created${label ? `: ${label}` : ''}\n`);
			return 0;
		} catch (error) {
			ctx.stderr.write(`newtab: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	};
}
