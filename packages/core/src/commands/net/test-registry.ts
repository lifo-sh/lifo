import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * test-registry - Test command to verify portRegistry is shared between tabs
 * Usage: test-registry [set|get]
 */
export function createTestRegistryCommand(kernel: Kernel): Command {
	return async (ctx) => {
		const action = ctx.args[0] || 'status';

		if (action === 'set') {
			// Register a dummy port for testing
			const testPort = 9999;
			const dummyHandler = () => {
				// Dummy handler
			};
			kernel.portRegistry.set(testPort, dummyHandler);
			ctx.stdout.write(`✅ Set test port ${testPort} in portRegistry\n`);
			ctx.stdout.write(`   Registry size: ${kernel.portRegistry.size}\n`);
			ctx.stdout.write(`   Registry instance: ${kernel.portRegistry.constructor.name}\n`);
			return 0;
		}

		if (action === 'get') {
			const testPort = 9999;
			const has = kernel.portRegistry.has(testPort);
			ctx.stdout.write(`Checking for test port ${testPort}:\n`);
			ctx.stdout.write(`  Has port: ${has}\n`);
			ctx.stdout.write(`  Registry size: ${kernel.portRegistry.size}\n`);
			return 0;
		}

		// Status
		ctx.stdout.write(`Port Registry Status:\n`);
		ctx.stdout.write(`  Size: ${kernel.portRegistry.size}\n`);
		ctx.stdout.write(`  Type: ${kernel.portRegistry.constructor.name}\n`);
		ctx.stdout.write(`  Instance: ${kernel.portRegistry}\n`);
		ctx.stdout.write(`\nUsage:\n`);
		ctx.stdout.write(`  test-registry set    # Set test port in Tab 1\n`);
		ctx.stdout.write(`  test-registry get    # Check for test port in Tab 2\n`);
		ctx.stdout.write(`\nIf "get" shows the port after "set", kernel is shared ✅\n`);
		return 0;
	};
}
