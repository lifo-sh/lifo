import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * ifconfig - Configure network interfaces
 * Usage: ifconfig [interface] [options]
 */
export function createIfconfigCommand(kernel: Kernel): Command {
  return async (ctx) => {
    const args = ctx.args;

    // No arguments: show all interfaces
    if (args.length === 0) {
      const interfaces = kernel.networkStack.getAllInterfaces();

      if (interfaces.length === 0) {
        ctx.stdout.write('No network interfaces\n');
        return 0;
      }

      for (let i = 0; i < interfaces.length; i++) {
        ctx.stdout.write(interfaces[i].toString());
        if (i < interfaces.length - 1) {
          ctx.stdout.write('\n\n');
        } else {
          ctx.stdout.write('\n');
        }
      }

      return 0;
    }

    const ifaceName = args[0];
    const iface = kernel.networkStack.getInterface(ifaceName);

    // Just interface name: show that interface
    if (args.length === 1) {
      if (!iface) {
        ctx.stderr.write(`ifconfig: ${ifaceName}: error fetching interface information: Device not found\n`);
        return 1;
      }

      ctx.stdout.write(iface.toString() + '\n');
      return 0;
    }

    // Interface configuration commands
    const command = args[1];

    switch (command) {
      case 'up':
        if (!iface) {
          ctx.stderr.write(`ifconfig: ${ifaceName}: Device not found\n`);
          return 1;
        }
        iface.up();
        ctx.stdout.write(`Interface ${ifaceName} is up\n`);
        return 0;

      case 'down':
        if (!iface) {
          ctx.stderr.write(`ifconfig: ${ifaceName}: Device not found\n`);
          return 1;
        }
        iface.down();
        ctx.stdout.write(`Interface ${ifaceName} is down\n`);
        return 0;

      default:
        // Try to parse as IP address
        if (isValidIP(command)) {
          if (!iface) {
            // Create new interface if it doesn't exist
            try {
              const newIface = kernel.networkStack.createInterface(ifaceName, 'ethernet');
              newIface.addAddress({
                version: 4,
                address: command,
                subnet: args[2] ? parseNetmask(args[2]) : '24',
              });
              ctx.stdout.write(`Created interface ${ifaceName} with address ${command}\n`);
              return 0;
            } catch (error) {
              ctx.stderr.write(`ifconfig: error creating interface: ${error instanceof Error ? error.message : String(error)}\n`);
              return 1;
            }
          }

          iface.addAddress({
            version: 4,
            address: command,
            subnet: args[2] ? parseNetmask(args[2]) : '24',
          });
          ctx.stdout.write(`Added address ${command} to ${ifaceName}\n`);
          return 0;
        }

        ctx.stderr.write(`ifconfig: unknown command: ${command}\n`);
        return 1;
    }
  };
}

/**
 * Check if string is valid IPv4 address
 */
function isValidIP(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255;
  });
}

/**
 * Parse netmask to CIDR prefix length
 */
function parseNetmask(mask: string): string {
  // If already CIDR, return as is
  if (!mask.includes('.')) {
    return mask;
  }

  // Convert netmask to CIDR
  const parts = mask.split('.');
  if (parts.length !== 4) {
    return '24'; // Default
  }

  let bits = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    bits += num.toString(2).split('1').length - 1;
  }

  return bits.toString();
}
