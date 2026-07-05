import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * forward - Forward a virtual port to the host browser
 * Usage: forward <port>
 * Example: forward 3000
 */
export function createForwardCommand(kernel: Kernel): Command {
	return async (ctx) => {
		if (ctx.args.length === 0) {
			ctx.stdout.write('Usage: forward <port>\n');
			ctx.stdout.write('Example: forward 3000\n');
			ctx.stdout.write('\nCurrently forwarded ports:\n');

			const forwarded = kernel.portBridge.getForwardedPorts();
			if (forwarded.length === 0) {
				ctx.stdout.write('  (none)\n');
			} else {
				for (const { virtual } of forwarded) {
					const hasHandler = kernel.portRegistry.has(virtual);
					const status = hasHandler ? '\x1b[32m●\x1b[0m' : '\x1b[33m○\x1b[0m';
					ctx.stdout.write(`  ${status} ${virtual} -> /api/proxy/${virtual}/\n`);
				}
			}
			ctx.stdout.write('\nLegend: \x1b[32m●\x1b[0m active  \x1b[33m○\x1b[0m registered (no handler)\n');
			return 0;
		}

		const port = parseInt(ctx.args[0], 10);
		if (isNaN(port) || port < 1 || port > 65535) {
			ctx.stderr.write(`forward: invalid port number: ${ctx.args[0]}\n`);
			return 1;
		}

		// Check if port has a handler
		const hasHandler = kernel.portRegistry.has(port);
		if (!hasHandler) {
			ctx.stdout.write(`\x1b[33m⚠\x1b[0m Warning: No service detected on port ${port}\n`);
			ctx.stdout.write(`  The port will be forwarded, but requests will fail until a server starts.\n`);
			ctx.stdout.write(`  This is useful for Vite/webpack dev servers that may not be fully tracked.\n\n`);
		}

		// Forward the port
		kernel.portBridge.forward(port);

		ctx.stdout.write(`\x1b[32m✓\x1b[0m Port ${port} forwarded successfully!\n\n`);
		ctx.stdout.write(`  Virtual port: ${port}\n`);
		ctx.stdout.write(`  Access URL:   \x1b[36m/api/proxy/${port}/\x1b[0m\n\n`);
		ctx.stdout.write(`You can now access this server from your browser:\n`);
		ctx.stdout.write(`  curl http://localhost:3000/api/proxy/${port}/\n`);
		ctx.stdout.write(`  Or open in browser: http://localhost:3000/api/proxy/${port}/\n\n`);

		if (hasHandler) {
			ctx.stdout.write(`\x1b[32m●\x1b[0m Server is active and ready\n`);
		} else {
			ctx.stdout.write(`\x1b[33m○\x1b[0m Waiting for server to start on port ${port}\n`);
		}

		return 0;
	};
}

/**
 * unforward - Stop forwarding a virtual port
 * Usage: unforward <port>
 */
export function createUnforwardCommand(kernel: Kernel): Command {
	return async (ctx) => {
		if (ctx.args.length === 0) {
			ctx.stderr.write('Usage: unforward <port>\n');
			return 1;
		}

		const port = parseInt(ctx.args[0], 10);
		if (isNaN(port) || port < 1 || port > 65535) {
			ctx.stderr.write(`unforward: invalid port number: ${ctx.args[0]}\n`);
			return 1;
		}

		const success = kernel.portBridge.unforward(port);
		if (success) {
			ctx.stdout.write(`Port ${port} unforwarded\n`);
			return 0;
		} else {
			ctx.stderr.write(`unforward: port ${port} is not forwarded\n`);
			return 1;
		}
	};
}
