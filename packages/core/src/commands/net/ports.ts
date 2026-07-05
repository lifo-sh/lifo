import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * ports - List all ports in the portRegistry with details
 * Usage: ports
 */
export function createPortsCommand(kernel: Kernel): Command {
	return async (ctx) => {
		// Debug: Show kernel info
		const hasRegistry = !!kernel.portRegistry;
		const registrySize = hasRegistry ? kernel.portRegistry.size : 0;

		ctx.stdout.write(`\x1b[90m[Debug] Kernel has portRegistry: ${hasRegistry}\x1b[0m\n`);
		ctx.stdout.write(`\x1b[90m[Debug] Registry size: ${registrySize}\x1b[0m\n`);
		ctx.stdout.write(`\x1b[90m[Debug] Registry instance: ${kernel.portRegistry ? 'Map' : 'undefined'}\x1b[0m\n\n`);

		const ports = Array.from(kernel.portRegistry.entries()).sort((a, b) => a[0] - b[0]);

		if (ports.length === 0) {
			ctx.stdout.write('No ports registered in portRegistry\n');
			ctx.stdout.write('\nDiagnostic steps:\n');
			ctx.stdout.write('  1. Run: node test-server.js\n');
			ctx.stdout.write('  2. Look for "[lifo-http] Server listening on port 3000"\n');
			ctx.stdout.write('  3. Run: ports (in the SAME tab)\n');
			ctx.stdout.write('  4. If still empty, there may be an error during server creation\n');
			return 0;
		}

		ctx.stdout.write('Registered ports in portRegistry:\n\n');
		ctx.stdout.write('Port   Handler   Description\n');
		ctx.stdout.write('-----  --------  -----------\n');

		for (const [port, handler] of ports) {
			const handlerStr = '\x1b[32m✓\x1b[0m    ';
			const handlerType = typeof handler;
			const desc = `Active (handler: ${handlerType})`;
			ctx.stdout.write(`${String(port).padEnd(6)} ${handlerStr}  ${desc}\n`);
		}

		ctx.stdout.write(`\nTotal: ${ports.length} port(s)\n`);
		ctx.stdout.write(`\nAccess: curl localhost:PORT or /api/proxy/PORT/ in browser\n`);
		return 0;
	};
}
