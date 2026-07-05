// @ts-nocheck
/**
 * NetworkStack Usage Examples
 *
 * This file demonstrates how to use the virtual network stack
 * for Linux-like networking in lifo.
 */

import { NetworkStack } from './NetworkStack.js';

// Example 1: Basic network interface setup
async function example1_BasicSetup() {
  const stack = new NetworkStack();

  // Create ethernet interface
  const eth0 = stack.createInterface('eth0', 'ethernet');
  eth0.addAddress({ version: 4, address: '192.168.1.10', subnet: '24' });
  eth0.up();

  // Add route
  stack.addRoute({
    destination: '192.168.1.0/24',
    interface: 'eth0',
    metric: 0,
    namespace: 'default',
  });

  // Add default gateway
  stack.addRoute({
    destination: '0.0.0.0/0',
    gateway: '192.168.1.1',
    interface: 'eth0',
    metric: 100,
    namespace: 'default',
  });

  console.log('Network configuration:');
  console.log(eth0.toString());
  console.log('\nRouting table:');
  console.log(stack.getRoutingTableString());
}

// Example 2: TCP socket communication
async function example2_TCPSocket() {
  const stack = new NetworkStack();

  // Create server socket
  const serverSocket = stack.createSocket('tcp');
  stack.bindSocket(serverSocket, { ip: '127.0.0.1', port: 8080 });
  serverSocket.listen();

  console.log('Server listening on 127.0.0.1:8080');

  // Create client socket
  const clientSocket = stack.createSocket('tcp');
  await clientSocket.connect({ ip: '127.0.0.1', port: 8080 });

  console.log('Client connected');

  // Send data
  const data = new TextEncoder().encode('Hello, server!');
  await clientSocket.send(data);

  console.log('Data sent from client');
}

// Example 3: DNS resolution
async function example3_DNSResolution() {
  const stack = new NetworkStack();
  const dns = stack.getDNS();

  // Add custom DNS record
  dns.addRecord({
    type: 'A',
    name: 'myapp.local',
    value: '192.168.1.100',
    ttl: 300,
  });

  // Resolve hostname
  const ip = await stack.resolveHostname('myapp.local');
  console.log(`myapp.local resolves to: ${ip}`);

  // Resolve localhost (built-in)
  const localhostIp = await stack.resolveHostname('localhost');
  console.log(`localhost resolves to: ${localhostIp}`);

  // Reverse lookup
  const hostname = dns.reverseLookup('192.168.1.100');
  console.log(`192.168.1.100 reverse lookup: ${hostname}`);
}

// Example 4: Network namespaces
async function example4_NetworkNamespaces() {
  const stack = new NetworkStack();

  // Create new namespace
  const nsId = stack.createNamespace('isolated');

  // Create interface in isolated namespace
  const eth0 = stack.createInterface('eth0', 'ethernet', nsId);
  eth0.addAddress({ version: 4, address: '10.0.0.10', subnet: '24' });
  eth0.up();

  // Create socket in isolated namespace
  const socket = stack.createSocket('tcp', nsId);
  stack.bindSocket(socket, { ip: '10.0.0.10', port: 9000 });

  console.log(`Created isolated namespace: ${nsId}`);
  console.log('Interfaces:', stack.getAllInterfaces(nsId));
  console.log('Sockets:', stack.getAllSockets(nsId));
}

// Example 5: SSH Tunnel (local port forwarding)
async function example5_SSHTunnel() {
  const stack = new NetworkStack();

  // This would typically be done through the ssh command:
  // ssh -L 8080:remote-server:80 user@ssh-server

  console.log('SSH tunnel would forward local port 8080 to remote-server:80');
  console.log('Usage: ssh -L 8080:remote-server:80 user@ssh-server');
  console.log('       ssh -R 9000:localhost:3000 user@ssh-server (remote forward)');
  console.log('       ssh -D 1080 user@ssh-server (SOCKS proxy)');
}

// Example 6: Packet routing
async function example6_PacketRouting() {
  const stack = new NetworkStack();

  // Setup network
  const eth0 = stack.createInterface('eth0', 'ethernet');
  eth0.addAddress({ version: 4, address: '192.168.1.10', subnet: '24' });
  eth0.up();

  stack.addRoute({
    destination: '192.168.1.0/24',
    interface: 'eth0',
    metric: 0,
    namespace: 'default',
  });

  // Create listening socket
  const server = stack.createSocket('tcp');
  stack.bindSocket(server, { ip: '192.168.1.10', port: 8080 });
  server.listen();

  // Send packet
  const packet = {
    source: { ip: '192.168.1.20', port: 12345 },
    destination: { ip: '192.168.1.10', port: 8080 },
    protocol: 'tcp' as const,
    data: new TextEncoder().encode('Hello!'),
    timestamp: Date.now(),
  };

  await stack.sendPacket(packet);
  console.log('Packet sent and routed to listening socket');
}

// Example 7: Complete network setup (like Linux)
async function example7_CompleteSetup() {
  const stack = new NetworkStack();

  // Setup loopback (already exists by default)
  console.log('Loopback interface:');
  const lo = stack.getInterface('lo');
  console.log(lo?.toString());

  // Setup eth0 with static IP
  const eth0 = stack.createInterface('eth0', 'ethernet');
  eth0.addAddress({ version: 4, address: '192.168.1.100', subnet: '24' });
  eth0.up();

  // Setup routes
  stack.addRoute({
    destination: '192.168.1.0/24',
    interface: 'eth0',
    metric: 0,
    namespace: 'default',
  });

  stack.addRoute({
    destination: '0.0.0.0/0',
    gateway: '192.168.1.1',
    interface: 'eth0',
    metric: 100,
    namespace: 'default',
  });

  // Configure DNS
  const dns = stack.getDNS();
  dns.addHost('gateway', '192.168.1.1');
  dns.addHost('server1', '192.168.1.10');

  console.log('\n=== Network Configuration ===');
  console.log('\n--- Interfaces ---');
  for (const iface of stack.getAllInterfaces()) {
    console.log(iface.toString());
    console.log('');
  }

  console.log('--- Routing Table ---');
  console.log(stack.getRoutingTableString());

  console.log('\n--- DNS Records ---');
  console.log('localhost ->', await stack.resolveHostname('localhost'));
  console.log('gateway ->', await stack.resolveHostname('gateway'));
  console.log('server1 ->', await stack.resolveHostname('server1'));
}

// Run example (uncomment to execute)
// example7_CompleteSetup();
