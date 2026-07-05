import { describe, it, expect, beforeEach } from 'vitest';
import { NetworkStack } from './NetworkStack.js';

describe('NetworkStack', () => {
  let stack: NetworkStack;

  beforeEach(() => {
    stack = new NetworkStack();
  });

  describe('Initialization', () => {
    it('should create default namespace', () => {
      const ns = stack.getNamespace('default');
      expect(ns).toBeDefined();
      expect(ns?.name).toBe('default');
    });

    it('should create loopback interface', () => {
      const lo = stack.getInterface('lo');
      expect(lo).toBeDefined();
      expect(lo?.type).toBe('loopback');
      expect(lo?.state).toBe('up');
    });

    it('should have loopback addresses', () => {
      const lo = stack.getInterface('lo');
      expect(lo?.addresses).toHaveLength(2);
      expect(lo?.hasAddress('127.0.0.1')).toBe(true);
      expect(lo?.hasAddress('::1')).toBe(true);
    });

    it('should have loopback route', () => {
      const routes = stack.getRoutes();
      const loRoute = routes.find((r) => r.interface === 'lo');
      expect(loRoute).toBeDefined();
      expect(loRoute?.destination).toBe('127.0.0.0/8');
    });
  });

  describe('Network Interfaces', () => {
    it('should create ethernet interface', () => {
      const eth0 = stack.createInterface('eth0', 'ethernet');
      expect(eth0).toBeDefined();
      expect(eth0.name).toBe('eth0');
      expect(eth0.type).toBe('ethernet');
      expect(eth0.mac).toBeDefined();
    });

    it('should add IP address to interface', () => {
      const eth0 = stack.createInterface('eth0', 'ethernet');
      eth0.addAddress({ version: 4, address: '192.168.1.10', subnet: '24' });

      expect(eth0.hasAddress('192.168.1.10')).toBe(true);
    });

    it('should bring interface up/down', () => {
      const eth0 = stack.createInterface('eth0', 'ethernet');
      expect(eth0.state).toBe('down');

      eth0.up();
      expect(eth0.state).toBe('up');

      eth0.down();
      expect(eth0.state).toBe('down');
    });

    it('should delete interface', () => {
      stack.createInterface('eth0', 'ethernet');
      const deleted = stack.deleteInterface('eth0');

      expect(deleted).toBe(true);
      expect(stack.getInterface('eth0')).toBeUndefined();
    });

    it('should get all interfaces', () => {
      stack.createInterface('eth0', 'ethernet');
      stack.createInterface('eth1', 'ethernet');

      const interfaces = stack.getAllInterfaces();
      expect(interfaces).toHaveLength(3); // lo, eth0, eth1
    });
  });

  describe('Routing Table', () => {
    beforeEach(() => {
      const eth0 = stack.createInterface('eth0', 'ethernet');
      eth0.addAddress({ version: 4, address: '192.168.1.10', subnet: '24' });
      eth0.up();
    });

    it('should add route', () => {
      stack.addRoute({
        destination: '192.168.1.0/24',
        interface: 'eth0',
        metric: 0,
        namespace: 'default',
      });

      const routes = stack.getRoutes();
      const route = routes.find((r) => r.destination === '192.168.1.0/24');
      expect(route).toBeDefined();
      expect(route?.interface).toBe('eth0');
    });

    it('should add default route', () => {
      stack.addRoute({
        destination: '0.0.0.0/0',
        gateway: '192.168.1.1',
        interface: 'eth0',
        metric: 100,
        namespace: 'default',
      });

      const route = stack.lookupRoute('8.8.8.8');
      expect(route).toBeDefined();
      expect(route?.gateway).toBe('192.168.1.1');
    });

    it('should lookup route for IP', () => {
      stack.addRoute({
        destination: '192.168.1.0/24',
        interface: 'eth0',
        metric: 0,
        namespace: 'default',
      });

      const route = stack.lookupRoute('192.168.1.50');
      expect(route).toBeDefined();
      expect(route?.interface).toBe('eth0');
    });

    it('should use longest prefix match', () => {
      stack.addRoute({
        destination: '192.168.0.0/16',
        interface: 'eth0',
        metric: 10,
        namespace: 'default',
      });

      stack.addRoute({
        destination: '192.168.1.0/24',
        interface: 'eth1',
        metric: 5,
        namespace: 'default',
      });

      const route = stack.lookupRoute('192.168.1.50');
      expect(route?.interface).toBe('eth1'); // More specific route
    });

    it('should remove route', () => {
      stack.addRoute({
        destination: '192.168.1.0/24',
        interface: 'eth0',
        metric: 0,
        namespace: 'default',
      });

      const removed = stack.removeRoute('192.168.1.0/24', 'eth0');
      expect(removed).toBe(true);

      const route = stack.lookupRoute('192.168.1.50');
      expect(route).toBeNull();
    });
  });

  describe('Sockets', () => {
    it('should create TCP socket', () => {
      const socket = stack.createSocket('tcp');
      expect(socket).toBeDefined();
      expect(socket.type).toBe('tcp');
      expect(socket.state).toBe('closed');
    });

    it('should create UDP socket', () => {
      const socket = stack.createSocket('udp');
      expect(socket).toBeDefined();
      expect(socket.type).toBe('udp');
    });

    it('should bind socket to address', () => {
      const socket = stack.createSocket('tcp');
      stack.bindSocket(socket, { ip: '127.0.0.1', port: 8080 });

      expect(socket.localAddress).toBeDefined();
      expect(socket.localAddress?.port).toBe(8080);
    });

    it('should fail to bind to already used address', () => {
      const socket1 = stack.createSocket('tcp');
      const socket2 = stack.createSocket('tcp');

      stack.bindSocket(socket1, { ip: '127.0.0.1', port: 8080 });

      expect(() => {
        stack.bindSocket(socket2, { ip: '127.0.0.1', port: 8080 });
      }).toThrow('Address already in use');
    });

    it('should connect socket', async () => {
      const socket = stack.createSocket('tcp');
      await socket.connect({ ip: '127.0.0.1', port: 8080 });

      expect(socket.state).toBe('established');
      expect(socket.remoteAddress).toBeDefined();
    });

    it('should listen on socket', () => {
      const socket = stack.createSocket('tcp');
      stack.bindSocket(socket, { ip: '127.0.0.1', port: 8080 });
      socket.listen();

      expect(socket.state).toBe('listen');
    });

    it('should close socket', () => {
      const socket = stack.createSocket('tcp');
      socket.close();

      expect(socket.state).toBe('closed');
    });

    it('should get all sockets in namespace', () => {
      stack.createSocket('tcp');
      stack.createSocket('tcp');
      stack.createSocket('udp');

      const sockets = stack.getAllSockets();
      expect(sockets).toHaveLength(3);
    });
  });

  describe('DNS Resolver', () => {
    it('should resolve localhost', async () => {
      const ip = await stack.resolveHostname('localhost');
      expect(ip).toBe('127.0.0.1');
    });

    it('should add DNS record', async () => {
      const dns = stack.getDNS();
      dns.addRecord({
        type: 'A',
        name: 'example.local',
        value: '192.168.1.100',
        ttl: 300,
      });

      const ip = await stack.resolveHostname('example.local');
      expect(ip).toBe('192.168.1.100');
    });

    it('should load hosts file', () => {
      const dns = stack.getDNS();
      dns.loadHostsFile(`
192.168.1.10    server1.local server1
192.168.1.20    server2.local server2
      `);

      expect(dns.getHost('server1.local')).toBe('192.168.1.10');
      expect(dns.getHost('server2.local')).toBe('192.168.1.20');
    });

    it('should reverse lookup IP', () => {
      const dns = stack.getDNS();
      dns.addHost('example.local', '192.168.1.100');

      const hostname = dns.reverseLookup('192.168.1.100');
      expect(hostname).toBe('example.local');
    });
  });

  describe('Network Namespaces', () => {
    it('should create namespace', () => {
      const nsId = stack.createNamespace('test');
      const ns = stack.getNamespace(nsId);

      expect(ns).toBeDefined();
      expect(ns?.name).toBe('test');
    });

    it('should delete namespace', () => {
      const nsId = stack.createNamespace('test');
      const deleted = stack.deleteNamespace(nsId);

      expect(deleted).toBe(true);
      expect(stack.getNamespace(nsId)).toBeUndefined();
    });

    it('should not delete default namespace', () => {
      expect(() => {
        stack.deleteNamespace('default');
      }).toThrow('Cannot delete default namespace');
    });

    it('should isolate interfaces between namespaces', () => {
      const nsId = stack.createNamespace('test');

      stack.createInterface('eth0', 'ethernet', 'default');
      stack.createInterface('eth0', 'ethernet', nsId);

      const defaultEth0 = stack.getInterface('eth0', 'default');
      const testEth0 = stack.getInterface('eth0', nsId);

      expect(defaultEth0).toBeDefined();
      expect(testEth0).toBeDefined();
      expect(defaultEth0?.namespace).toBe('default');
      expect(testEth0?.namespace).toBe(nsId);
    });

    it('should get all namespaces', () => {
      stack.createNamespace('test1');
      stack.createNamespace('test2');

      const namespaces = stack.getAllNamespaces();
      expect(namespaces.length).toBeGreaterThanOrEqual(3); // default + test1 + test2
    });
  });

  describe('Packet Routing', () => {
    beforeEach(() => {
      const eth0 = stack.createInterface('eth0', 'ethernet');
      eth0.addAddress({ version: 4, address: '192.168.1.10', subnet: '24' });
      eth0.up();

      stack.addRoute({
        destination: '192.168.1.0/24',
        interface: 'eth0',
        metric: 0,
        namespace: 'default',
      });
    });

    it('should send packet through interface', async () => {
      const packet = {
        source: { ip: '192.168.1.10', port: 12345 },
        destination: { ip: '192.168.1.20', port: 80 },
        protocol: 'tcp' as const,
        data: new Uint8Array([1, 2, 3, 4]),
        timestamp: Date.now(),
      };

      await expect(stack.sendPacket(packet)).resolves.not.toThrow();
    });

    it('should fail to send without route', async () => {
      const packet = {
        source: { ip: '192.168.1.10', port: 12345 },
        destination: { ip: '10.0.0.1', port: 80 },
        protocol: 'tcp' as const,
        data: new Uint8Array([1, 2, 3, 4]),
        timestamp: Date.now(),
      };

      await expect(stack.sendPacket(packet)).rejects.toThrow('No route to host');
    });
  });
});
