import type { Command } from '../types.js';
import type { Kernel } from '../../kernel/index.js';

/**
 * host - DNS lookup and /etc/hosts management
 *
 * Usage:
 *   host <hostname>              - DNS lookup
 *   host list                    - List /etc/hosts entries
 *   host add <hostname> <ip>     - Add entry to /etc/hosts
 *   host remove <hostname>       - Remove entry from /etc/hosts
 *   host reload                  - Reload /etc/hosts into DNS
 */
export function createHostCommand(kernel: Kernel): Command {
  return async (ctx) => {
    const args = ctx.args;

    if (args.length === 0) {
      ctx.stderr.write(`Usage: host <hostname>              - DNS lookup
       host list                    - List /etc/hosts entries
       host add <hostname> <ip>     - Add entry to /etc/hosts
       host remove <hostname>       - Remove entry from /etc/hosts
       host reload                  - Reload /etc/hosts into DNS\n`);
      return 1;
    }

    const subcommand = args[0];

    // List /etc/hosts entries
    if (subcommand === 'list') {
      try {
        const content = ctx.vfs.readFileString('/etc/hosts');
        ctx.stdout.write(content);
        if (!content.endsWith('\n')) {
          ctx.stdout.write('\n');
        }
        return 0;
      } catch {
        ctx.stderr.write('host: cannot read /etc/hosts\n');
        return 1;
      }
    }

    // Add entry to /etc/hosts
    if (subcommand === 'add') {
      if (args.length < 3) {
        ctx.stderr.write('host: add requires <hostname> <ip>\n');
        return 1;
      }

      const hostname = args[1];
      const ip = args[2];

      // Validate IP address format (basic validation)
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

      if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
        ctx.stderr.write(`host: invalid IP address: ${ip}\n`);
        return 1;
      }

      try {
        // Read current hosts file
        let content = '';
        try {
          content = ctx.vfs.readFileString('/etc/hosts');
        } catch {
          // File doesn't exist, will create
        }

        // Check if entry already exists
        const lines = content.split('\n');
        const exists = lines.some(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || !trimmed) return false;
          const parts = trimmed.split(/\s+/);
          return parts.slice(1).includes(hostname);
        });

        if (exists) {
          ctx.stderr.write(`host: entry for ${hostname} already exists\n`);
          return 1;
        }

        // Add new entry
        const newLine = `${ip}\t${hostname}`;
        const newContent = content.trim() + '\n' + newLine + '\n';

        ctx.vfs.writeFile('/etc/hosts', newContent);

        // Reload DNS
        kernel.networkStack.getDNS().loadHostsFile(newContent);

        ctx.stdout.write(`Added: ${newLine}\n`);
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.stderr.write(`host: ${msg}\n`);
        return 1;
      }
    }

    // Remove entry from /etc/hosts
    if (subcommand === 'remove') {
      if (args.length < 2) {
        ctx.stderr.write('host: remove requires <hostname>\n');
        return 1;
      }

      const hostname = args[1];

      try {
        const content = ctx.vfs.readFileString('/etc/hosts');
        const lines = content.split('\n');

        // Remove lines containing the hostname
        const newLines = lines.filter(line => {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || !trimmed) return true;
          const parts = trimmed.split(/\s+/);
          return !parts.slice(1).includes(hostname);
        });

        if (newLines.length === lines.length) {
          ctx.stderr.write(`host: no entry found for ${hostname}\n`);
          return 1;
        }

        const newContent = newLines.join('\n');
        ctx.vfs.writeFile('/etc/hosts', newContent);

        // Reload DNS
        kernel.networkStack.getDNS().loadHostsFile(newContent);

        ctx.stdout.write(`Removed entry for: ${hostname}\n`);
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.stderr.write(`host: ${msg}\n`);
        return 1;
      }
    }

    // Reload /etc/hosts
    if (subcommand === 'reload') {
      try {
        const content = ctx.vfs.readFileString('/etc/hosts');
        kernel.networkStack.getDNS().loadHostsFile(content);
        ctx.stdout.write('Reloaded /etc/hosts\n');
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.stderr.write(`host: ${msg}\n`);
        return 1;
      }
    }

    // DNS lookup (default)
    const hostname = subcommand;

    try {
      // First try to lookup in cache/hosts
      const dns = kernel.networkStack.getDNS();
      const cached = dns.getHost(hostname);

      if (cached) {
        ctx.stdout.write(`${hostname} has address ${cached}\n`);
        return 0;
      }

      // Try full DNS resolution
      const ip = await kernel.networkStack.resolveHostname(hostname);
      ctx.stdout.write(`${hostname} has address ${ip}\n`);
      return 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.stderr.write(`host: ${msg}\n`);
      return 1;
    }
  };
}
