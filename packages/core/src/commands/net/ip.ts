import type { Command } from '../types.js';
import type { NetworkStack } from '../../kernel/network/index.js';
import type { Kernel } from '../../kernel/index.js';
import { VETHPair } from '../../kernel/network/tunnel/VETHPair.js';
import { Bridge } from '../../kernel/network/Bridge.js';

/**
 * ip - Modern Linux network configuration tool
 *
 * Subcommands:
 *   ip link       - Manage network interfaces
 *   ip addr       - Manage IP addresses
 *   ip route      - Manage routing table
 *   ip tunnel     - Manage tunnels
 *   ip netns      - Manage network namespaces
 */
export function createIPCommand(kernel: Kernel): Command {
  return async (ctx) => {
    const args = ctx.args;

    if (args.length === 0) {
      ctx.stdout.write(`Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }

OBJECT := { link | addr | route | netns | bridge }

OPTIONS := { -4 | -6 | -s | -d }

Examples:
  ip link show
  ip addr add 192.168.1.10/24 dev eth0
  ip route add default via 192.168.1.1
  ip link add veth0 type veth peer name veth1
  ip link add br0 type bridge
  ip netns add container1
  bridge fdb show\n`);
      return 0;
    }

    const object = args[0];
    const command = args[1] || 'show';
    const rest = args.slice(2);

    switch (object) {
      case 'link':
        return await handleLink(ctx, command, rest, kernel.networkStack);
      case 'addr':
      case 'address':
        return await handleAddr(ctx, command, rest, kernel.networkStack);
      case 'route':
        return await handleRoute(ctx, command, rest, kernel.networkStack);
      case 'netns':
        return await handleNetns(ctx, command, rest, kernel.networkStack);
      case 'bridge':
        return await handleBridge(ctx, command, rest, kernel.networkStack);
      default:
        ctx.stderr.write(`Unknown object: ${object}\n`);
        ctx.stderr.write(`Try: ip { link | addr | route | netns | bridge }\n`);
        return 1;
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// ip link - Network Interface Management
// ═══════════════════════════════════════════════════════════════

async function handleLink(
  ctx: any,
  command: string,
  args: string[],
  networkStack: NetworkStack
): Promise<number> {
  switch (command) {
    case 'show':
    case 'list':
      return await linkShow(ctx, args, networkStack);
    case 'add':
      return await linkAdd(ctx, args, networkStack);
    case 'del':
    case 'delete':
      return await linkDelete(ctx, args, networkStack);
    case 'set':
      return await linkSet(ctx, args, networkStack);
    case 'help':
      ctx.stdout.write(`Usage: ip link { show | add | del | set } [ OPTIONS ]

ip link show [ dev NAME ]
ip link add NAME type { veth | bridge } [ OPTIONS ]
ip link add NAME type veth peer name PEER
ip link add NAME type bridge
ip link del NAME
ip link set NAME { up | down }
ip link set NAME netns NETNSNAME
ip link set NAME master BRIDGE
ip link set NAME nomaster

Examples:
  ip link show
  ip link add veth0 type veth peer name veth1
  ip link add br0 type bridge
  ip link set veth0 master br0
  ip link set veth1 netns container1
  ip link set eth0 up\n`);
      return 0;
    default:
      ctx.stderr.write(`Unknown link command: ${command}\n`);
      return 1;
  }
}

async function linkShow(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  let targetInterface: string | undefined;

  // Parse "dev NAME"
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      targetInterface = args[++i];
    }
  }

  const namespaces = networkStack.getAllNamespaces();

  for (const ns of namespaces) {
    const interfaces = ns.getAllInterfaces();

    for (const iface of interfaces) {
      if (targetInterface && iface.name !== targetInterface) {
        continue;
      }

      const index = 1; // Would be real ifindex in Linux
      const state = iface.state.toUpperCase();
      const mtu = iface.mtu;
      const type = iface.type.toUpperCase();

      ctx.stdout.write(`${index}: ${iface.name}: <${state}> mtu ${mtu} type ${type}\n`);

      if (iface.mac) {
        ctx.stdout.write(`    link/ether ${iface.mac}\n`);
      }

      for (const addr of iface.addresses) {
        const family = addr.version === 4 ? 'inet' : 'inet6';
        ctx.stdout.write(`    ${family} ${addr.address}/${addr.subnet || (addr.version === 4 ? '32' : '128')}\n`);
      }

      // Show namespace if not default
      if (ns.id !== 'default') {
        ctx.stdout.write(`    netns: ${ns.name} (${ns.id})\n`);
      }
    }
  }

  return 0;
}

async function linkAdd(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  if (args.length < 3) {
    ctx.stderr.write('Usage: ip link add NAME type TYPE [ OPTIONS ]\n');
    return 1;
  }

  const name = args[0];
  const typeIdx = args.indexOf('type');

  if (typeIdx === -1 || !args[typeIdx + 1]) {
    ctx.stderr.write('Error: type is required\n');
    return 1;
  }

  const type = args[typeIdx + 1];

  if (type === 'veth') {
    // Find peer name
    const peerIdx = args.indexOf('peer');
    const nameIdx = args.indexOf('name', peerIdx);

    if (peerIdx === -1 || nameIdx === -1 || !args[nameIdx + 1]) {
      ctx.stderr.write('Error: veth requires peer name\n');
      ctx.stderr.write('Usage: ip link add NAME type veth peer name PEER\n');
      return 1;
    }

    const peerName = args[nameIdx + 1];

    // Create VETH pair
    const id = networkStack.getNextTunnelId();
    const vethPair = new VETHPair(id, name, peerName, networkStack);

    networkStack.addVETHPair(id, vethPair);

    ctx.stdout.write(`Created veth pair: ${name} <-> ${peerName}\n`);
    return 0;
  }

  if (type === 'bridge') {
    // Create bridge
    const bridge = new Bridge(name, networkStack);
    networkStack.addBridge(name, bridge);

    ctx.stdout.write(`Created bridge: ${name}\n`);
    return 0;
  }

  ctx.stderr.write(`Error: unsupported type: ${type}\n`);
  ctx.stderr.write(`Supported types: veth, bridge\n`);
  return 1;
}

async function linkDelete(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  if (args.length < 1) {
    ctx.stderr.write('Usage: ip link del NAME\n');
    return 1;
  }

  const name = args[0];

  // Check if it's a VETH interface
  const vethPair = networkStack.getVETHPair(name);
  if (vethPair) {
    await networkStack.removeVETHPair(vethPair.id);
    ctx.stdout.write(`Deleted veth pair\n`);
    return 0;
  }

  // Check if it's a tunnel interface
  const tunnel = networkStack.getTunnel(name);
  if (tunnel) {
    await networkStack.removeTunnel(name);
    ctx.stdout.write(`Deleted tunnel ${name}\n`);
    return 0;
  }

  // Check if it's a bridge
  const bridge = networkStack.getBridge(name);
  if (bridge) {
    await networkStack.removeBridge(name);
    ctx.stdout.write(`Deleted bridge ${name}\n`);
    return 0;
  }

  ctx.stderr.write(`Error: interface ${name} not found\n`);
  return 1;
}

async function linkSet(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  if (args.length < 2) {
    ctx.stderr.write('Usage: ip link set NAME { up | down | netns NETNS }\n');
    return 1;
  }

  const name = args[0];
  const operation = args[1];

  // Find the interface
  const namespaces = networkStack.getAllNamespaces();
  let iface = null;

  for (const ns of namespaces) {
    iface = ns.getInterface(name);
    if (iface) break;
  }

  if (!iface) {
    ctx.stderr.write(`Error: interface ${name} not found\n`);
    return 1;
  }

  if (operation === 'up') {
    iface.up();
    ctx.stdout.write(`Interface ${name} is now UP\n`);
    return 0;
  }

  if (operation === 'down') {
    iface.down();
    ctx.stdout.write(`Interface ${name} is now DOWN\n`);
    return 0;
  }

  if (operation === 'netns') {
    if (!args[2]) {
      ctx.stderr.write('Error: netns name required\n');
      return 1;
    }

    const targetNs = args[2];

    // Check if target namespace exists
    let nsId = targetNs;
    const allNs = networkStack.getAllNamespaces();
    const foundNs = allNs.find((ns) => ns.name === targetNs || ns.id === targetNs);

    if (!foundNs) {
      ctx.stderr.write(`Error: namespace ${targetNs} not found\n`);
      return 1;
    }

    nsId = foundNs.id;

    // Check if this is part of a VETH pair
    const vethPair = networkStack.getVETHPair(name);
    if (vethPair) {
      const which = vethPair.veth0.name === name ? 0 : 1;
      await vethPair.moveToNamespace(which, nsId);
      ctx.stdout.write(`Moved ${name} to namespace ${targetNs}\n`);
      return 0;
    }

    // Move regular interface (not implemented for tunnels yet)
    ctx.stderr.write(`Error: moving interface type not supported yet\n`);
    return 1;
  }

  if (operation === 'master') {
    // Add interface to bridge
    if (!args[2]) {
      ctx.stderr.write('Error: bridge name required\n');
      return 1;
    }

    const bridgeName = args[2];
    const bridge = networkStack.getBridge(bridgeName);

    if (!bridge) {
      ctx.stderr.write(`Error: bridge ${bridgeName} not found\n`);
      return 1;
    }

    bridge.addPort(iface);
    ctx.stdout.write(`Added ${name} to bridge ${bridgeName}\n`);
    return 0;
  }

  if (operation === 'nomaster') {
    // Remove interface from all bridges
    const bridges = networkStack.getAllBridges();
    let removed = false;

    for (const bridge of bridges) {
      if (bridge.hasPort(name)) {
        bridge.removePort(name);
        ctx.stdout.write(`Removed ${name} from bridge ${bridge.name}\n`);
        removed = true;
      }
    }

    if (!removed) {
      ctx.stderr.write(`Error: ${name} is not attached to any bridge\n`);
      return 1;
    }

    return 0;
  }

  ctx.stderr.write(`Error: unknown operation: ${operation}\n`);
  return 1;
}

// ═══════════════════════════════════════════════════════════════
// ip addr - Address Management
// ═══════════════════════════════════════════════════════════════

async function handleAddr(
  ctx: any,
  command: string,
  _args: string[],
  _networkStack: NetworkStack
): Promise<number> {
  if (command === 'help') {
    ctx.stdout.write(`Usage: ip addr { show | add | del } [ OPTIONS ]

ip addr show [ dev NAME ]
ip addr add ADDRESS/PREFIX dev NAME
ip addr del ADDRESS/PREFIX dev NAME

Examples:
  ip addr show
  ip addr add 192.168.1.10/24 dev eth0
  ip addr add 2001:db8::1/64 dev eth0
  ip addr del 192.168.1.10/24 dev eth0\n`);
    return 0;
  }

  // For now, delegate to ifconfig for simplicity
  ctx.stdout.write(`Note: Use 'ifconfig' for address management\n`);
  ctx.stdout.write(`Example: ifconfig eth0 192.168.1.10 netmask 255.255.255.0\n`);
  return 0;
}

// ═══════════════════════════════════════════════════════════════
// ip route - Routing Management
// ═══════════════════════════════════════════════════════════════

async function handleRoute(
  ctx: any,
  command: string,
  _args: string[],
  _networkStack: NetworkStack
): Promise<number> {
  if (command === 'help') {
    ctx.stdout.write(`Usage: ip route { show | add | del } [ OPTIONS ]

ip route show
ip route add DESTINATION via GATEWAY dev NAME
ip route add default via GATEWAY
ip route del DESTINATION

Examples:
  ip route show
  ip route add 192.168.2.0/24 via 192.168.1.1 dev eth0
  ip route add default via 192.168.1.1
  ip route del 192.168.2.0/24\n`);
    return 0;
  }

  // For now, delegate to route command
  ctx.stdout.write(`Note: Use 'route' command for routing management\n`);
  ctx.stdout.write(`Example: route add default gw 192.168.1.1 dev eth0\n`);
  return 0;
}


// ═══════════════════════════════════════════════════════════════
// ip netns - Network Namespace Management
// ═══════════════════════════════════════════════════════════════

async function handleNetns(
  ctx: any,
  command: string,
  args: string[],
  networkStack: NetworkStack
): Promise<number> {
  switch (command) {
    case 'list':
    case 'show':
      return await netnsShow(ctx, args, networkStack);
    case 'add':
      return await netnsAdd(ctx, args, networkStack);
    case 'del':
    case 'delete':
      return await netnsDelete(ctx, args, networkStack);
    case 'help':
      ctx.stdout.write(`Usage: ip netns { list | add | del } [ NAME ]

ip netns list
ip netns add NAME
ip netns del NAME

Examples:
  ip netns list
  ip netns add container1
  ip netns del container1\n`);
      return 0;
    default:
      ctx.stderr.write(`Unknown netns command: ${command}\n`);
      return 1;
  }
}

async function netnsShow(ctx: any, _args: string[], networkStack: NetworkStack): Promise<number> {
  const namespaces = networkStack.getAllNamespaces();

  for (const ns of namespaces) {
    ctx.stdout.write(`${ns.name} (id: ${ns.id})\n`);
  }

  return 0;
}

async function netnsAdd(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  if (args.length < 1) {
    ctx.stderr.write('Usage: ip netns add NAME\n');
    return 1;
  }

  const name = args[0];

  try {
    const id = networkStack.createNamespace(name);
    ctx.stdout.write(`Created namespace: ${name} (id: ${id})\n`);
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${msg}\n`);
    return 1;
  }
}

async function netnsDelete(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  if (args.length < 1) {
    ctx.stderr.write('Usage: ip netns del NAME\n');
    return 1;
  }

  const name = args[0];

  // Find namespace by name
  const namespaces = networkStack.getAllNamespaces();
  const ns = namespaces.find((n) => n.name === name || n.id === name);

  if (!ns) {
    ctx.stderr.write(`Error: namespace ${name} not found\n`);
    return 1;
  }

  try {
    networkStack.deleteNamespace(ns.id);
    ctx.stdout.write(`Deleted namespace: ${name}\n`);
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${msg}\n`);
    return 1;
  }
}

// ═══════════════════════════════════════════════════════════════
// bridge - Bridge Management
// ═══════════════════════════════════════════════════════════════

async function handleBridge(
  ctx: any,
  command: string,
  args: string[],
  networkStack: NetworkStack
): Promise<number> {
  switch (command) {
    case 'fdb':
      return await bridgeFdb(ctx, args, networkStack);
    case 'link':
      return await bridgeLink(ctx, args, networkStack);
    case 'help':
      ctx.stdout.write(`Usage: bridge { fdb | link } [ OPTIONS ]

bridge fdb show [ dev BRIDGE ]
bridge link show [ dev BRIDGE ]

Examples:
  bridge fdb show
  bridge fdb show dev br0
  bridge link show\n`);
      return 0;
    default:
      ctx.stderr.write(`Unknown bridge command: ${command}\n`);
      return 1;
  }
}

async function bridgeFdb(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  const command = args[0] || 'show';

  if (command !== 'show') {
    ctx.stderr.write('Usage: bridge fdb show [ dev BRIDGE ]\n');
    return 1;
  }

  let targetBridge: string | undefined;

  // Parse "dev BRIDGE"
  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      targetBridge = args[++i];
    }
  }

  const bridges = networkStack.getAllBridges();

  if (bridges.length === 0) {
    ctx.stdout.write('No bridges found\n');
    return 0;
  }

  for (const bridge of bridges) {
    if (targetBridge && bridge.name !== targetBridge) {
      continue;
    }

    const fdbLines = bridge.showFdb();
    for (const line of fdbLines) {
      ctx.stdout.write(line + '\n');
    }
  }

  return 0;
}

async function bridgeLink(ctx: any, args: string[], networkStack: NetworkStack): Promise<number> {
  const command = args[0] || 'show';

  if (command !== 'show') {
    ctx.stderr.write('Usage: bridge link show [ dev BRIDGE ]\n');
    return 1;
  }

  let targetBridge: string | undefined;

  // Parse "dev BRIDGE"
  for (let i = 1; i < args.length; i++) {
    if (args[i] === 'dev' && args[i + 1]) {
      targetBridge = args[++i];
    }
  }

  const bridges = networkStack.getAllBridges();

  if (bridges.length === 0) {
    ctx.stdout.write('No bridges found\n');
    return 0;
  }

  for (const bridge of bridges) {
    if (targetBridge && bridge.name !== targetBridge) {
      continue;
    }

    ctx.stdout.write(`Bridge: ${bridge.name}\n`);
    const ports = bridge.getPorts();

    if (ports.length === 0) {
      ctx.stdout.write('  No ports\n');
    } else {
      for (const port of ports) {
        const state = port.state.toUpperCase();
        ctx.stdout.write(`  ${port.name}: <${state}> mtu ${port.mtu}\n`);
      }
    }

    ctx.stdout.write('\n');
  }

  return 0;
}
