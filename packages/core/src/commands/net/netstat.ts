import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * netstat - Print network connections, routing tables, interface statistics
 * Usage: netstat [-r] [-i] [-a]
 */
export function createNetstatCommand(kernel: Kernel): Command {
  return async (ctx) => {
    const args = ctx.args;

    // Parse flags
    let showRouting = false;
    let showInterfaces = false;
    let showAll = false;

    for (const arg of args) {
      if (arg === '-r') {
        showRouting = true;
      } else if (arg === '-i') {
        showInterfaces = true;
      } else if (arg === '-a') {
        showAll = true;
      } else if (arg.startsWith('-')) {
        // Support combined flags like -ri
        if (arg.includes('r')) showRouting = true;
        if (arg.includes('i')) showInterfaces = true;
        if (arg.includes('a')) showAll = true;
      }
    }

    // If no flags, show connections
    if (!showRouting && !showInterfaces) {
      showAll = true;
    }

    let output = '';

    // Show routing table
    if (showRouting) {
      output += 'Kernel IP routing table\n';
      output += kernel.networkStack.getRoutingTableString() + '\n';
      if (showInterfaces || showAll) {
        output += '\n';
      }
    }

    // Show interfaces
    if (showInterfaces) {
      output += 'Kernel Interface table\n';
      output += 'Iface      MTU    RX-OK  RX-ERR  TX-OK  TX-ERR  Flags\n';

      const interfaces = kernel.networkStack.getAllInterfaces();
      for (const iface of interfaces) {
        const name = iface.name.padEnd(10);
        const mtu = iface.mtu.toString().padStart(6);
        const rxOk = iface.stats.rxPackets.toString().padStart(7);
        const rxErr = iface.stats.rxErrors.toString().padStart(7);
        const txOk = iface.stats.txPackets.toString().padStart(7);
        const txErr = iface.stats.txErrors.toString().padStart(7);
        const flags = iface.state === 'up' ? 'UP' : 'DOWN';

        output += `${name} ${mtu} ${rxOk} ${rxErr} ${txOk} ${txErr} ${flags}\n`;
      }

      if (showAll) {
        output += '\n';
      }
    }

    // Show connections
    if (showAll) {
      output += 'Active Internet connections\n';
      output += 'Proto Local Address          Foreign Address        State\n';

      const sockets = kernel.networkStack.getAllSockets();
      let hasConnections = false;

      // Show NetworkStack sockets
      for (const socket of sockets) {
        output += socket.toString() + '\n';
        hasConnections = true;
      }

      // Also show portRegistry connections (Node.js HTTP servers)
      if (kernel.portRegistry) {
        const ports = Array.from(kernel.portRegistry.keys()).sort((a, b) => a - b);
        for (const port of ports) {
          const proto = 'TCP  ';
          const local = `127.0.0.1:${port}`.padEnd(22);
          const remote = '*:*'.padEnd(22);
          const state = 'LISTEN';
          output += `${proto} ${local} ${remote} ${state}\n`;
          hasConnections = true;
        }
      }

      if (!hasConnections) {
        output += '(No connections)\n';
      }
    }

    ctx.stdout.write(output);
    return 0;
  };
}
