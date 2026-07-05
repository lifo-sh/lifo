import type { Command } from '../types.js';
import type { NetworkStack } from '../../kernel/network/index.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * route - Show/manipulate IP routing table
 * Usage: route [-n] [add|del] [destination] [gw gateway] [dev interface]
 */
export function createRouteCommand(kernel: Kernel): Command {
  return async (ctx) => {
    const args = ctx.args;

    // No arguments: show routing table
    if (args.length === 0 || args[0] === '-n') {
      const table = kernel.networkStack.getRoutingTableString();
      ctx.stdout.write(table + '\n');
      return 0;
    }

    const command = args[0];

    switch (command) {
      case 'add':
        return addRoute(ctx, args.slice(1), kernel.networkStack);

      case 'del':
      case 'delete':
        return deleteRoute(ctx, args.slice(1), kernel.networkStack);

      default:
        ctx.stderr.write('Usage: route [-n] [add|del] [destination] [gw gateway] [dev interface]\n');
        return 1;
    }
  };
}

/**
 * Add route to routing table
 */
function addRoute(
  ctx: { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } },
  args: string[],
  networkStack: NetworkStack
): number {
  if (args.length < 2) {
    ctx.stderr.write('Usage: route add <destination> [gw <gateway>] dev <interface>\n');
    return 1;
  }

  let destination = args[0];
  let gateway: string | undefined;
  let iface: string | undefined;
  let metric = 0;

  // Parse arguments
  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg === 'gw') {
      gateway = args[i + 1];
      i += 2;
    } else if (arg === 'dev') {
      iface = args[i + 1];
      i += 2;
    } else if (arg === 'metric') {
      metric = parseInt(args[i + 1], 10) || 0;
      i += 2;
    } else {
      i++;
    }
  }

  if (!iface) {
    ctx.stderr.write('route: interface required (use "dev <interface>")\n');
    return 1;
  }

  // Handle special destinations
  if (destination === 'default') {
    destination = '0.0.0.0/0';
  } else if (!destination.includes('/')) {
    destination += '/32'; // Single host
  }

  try {
    networkStack.addRoute({
      destination,
      gateway,
      interface: iface,
      metric,
      namespace: 'default',
    });

    ctx.stdout.write(`Route added: ${destination} via ${gateway || '*'} dev ${iface}\n`);
    return 0;
  } catch (error) {
    ctx.stderr.write(`route: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Delete route from routing table
 */
function deleteRoute(
  ctx: { stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } },
  args: string[],
  networkStack: NetworkStack
): number {
  if (args.length < 2) {
    ctx.stderr.write('Usage: route del <destination> dev <interface>\n');
    return 1;
  }

  let destination = args[0];
  let iface: string | undefined;

  // Parse arguments
  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg === 'dev') {
      iface = args[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  if (!iface) {
    ctx.stderr.write('route: interface required (use "dev <interface>")\n');
    return 1;
  }

  // Handle special destinations
  if (destination === 'default') {
    destination = '0.0.0.0/0';
  } else if (!destination.includes('/')) {
    destination += '/32';
  }

  const removed = networkStack.removeRoute(destination, iface);

  if (removed) {
    ctx.stdout.write(`Route deleted: ${destination} dev ${iface}\n`);
    return 0;
  } else {
    ctx.stderr.write(`route: no such route\n`);
    return 1;
  }
}
