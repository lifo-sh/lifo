import type { NetworkNamespace as INetworkNamespace, RouteEntry, Socket } from './types.js';
import type { NetworkInterface } from './NetworkInterface.js';

/**
 * Network namespace implementation
 * Provides network isolation like Linux network namespaces
 */
export class NetworkNamespace implements INetworkNamespace {
  id: string;
  name: string;
  interfaces: Map<string, NetworkInterface>;
  routes: RouteEntry[];
  sockets: Map<number, Socket>;
  arpTable: Map<string, string>;

  private nextFd = 3; // Start from 3 (0=stdin, 1=stdout, 2=stderr)

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.interfaces = new Map();
    this.routes = [];
    this.sockets = new Map();
    this.arpTable = new Map();
  }

  /**
   * Add interface to namespace
   */
  addInterface(iface: NetworkInterface): void {
    this.interfaces.set(iface.name, iface);
  }

  /**
   * Remove interface from namespace
   */
  removeInterface(name: string): boolean {
    return this.interfaces.delete(name);
  }

  /**
   * Get interface by name
   */
  getInterface(name: string): NetworkInterface | undefined {
    return this.interfaces.get(name);
  }

  /**
   * Get all interfaces
   */
  getAllInterfaces(): NetworkInterface[] {
    return Array.from(this.interfaces.values());
  }

  /**
   * Add route
   */
  addRoute(route: RouteEntry): void {
    // Update namespace to match this namespace
    route.namespace = this.id;
    this.routes.push(route);
  }

  /**
   * Remove route
   */
  removeRoute(destination: string, iface: string): boolean {
    const initialLength = this.routes.length;
    this.routes = this.routes.filter(
      (r) => !(r.destination === destination && r.interface === iface)
    );
    return this.routes.length < initialLength;
  }

  /**
   * Get all routes
   */
  getRoutes(): RouteEntry[] {
    return [...this.routes];
  }

  /**
   * Add socket to namespace
   */
  addSocket(socket: Socket): void {
    this.sockets.set(socket.fd, socket);
  }

  /**
   * Remove socket from namespace
   */
  removeSocket(fd: number): boolean {
    return this.sockets.delete(fd);
  }

  /**
   * Get socket by file descriptor
   */
  getSocket(fd: number): Socket | undefined {
    return this.sockets.get(fd);
  }

  /**
   * Get all sockets
   */
  getAllSockets(): Socket[] {
    return Array.from(this.sockets.values());
  }

  /**
   * Allocate file descriptor for new socket
   */
  allocateFd(): number {
    return this.nextFd++;
  }

  /**
   * Add ARP entry (IP -> MAC mapping)
   */
  addArpEntry(ip: string, mac: string): void {
    this.arpTable.set(ip, mac);
  }

  /**
   * Remove ARP entry
   */
  removeArpEntry(ip: string): boolean {
    return this.arpTable.delete(ip);
  }

  /**
   * Lookup MAC address for IP
   */
  arpLookup(ip: string): string | undefined {
    return this.arpTable.get(ip);
  }

  /**
   * Get all ARP entries
   */
  getArpTable(): Map<string, string> {
    return new Map(this.arpTable);
  }

  /**
   * Clear all ARP entries
   */
  clearArpTable(): void {
    this.arpTable.clear();
  }

  /**
   * Clone namespace (for creating new network namespace)
   */
  clone(newId: string, newName: string): NetworkNamespace {
    const ns = new NetworkNamespace(newId, newName);

    // Copy routes (interfaces are not cloned, must be moved/created separately)
    for (const route of this.routes) {
      ns.addRoute({ ...route });
    }

    return ns;
  }

  /**
   * Get namespace statistics
   */
  getStats(): {
    interfaces: number;
    routes: number;
    sockets: number;
    arpEntries: number;
  } {
    return {
      interfaces: this.interfaces.size,
      routes: this.routes.length,
      sockets: this.sockets.size,
      arpEntries: this.arpTable.size,
    };
  }
}
