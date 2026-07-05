import type { RouteEntry } from './types.js';

/**
 * Routing table for IP packet routing
 * Implements longest prefix matching
 */
export class RoutingTable {
  private routes: RouteEntry[] = [];

  /**
   * Add route to table
   */
  addRoute(route: RouteEntry): void {
    // Remove existing route with same destination and interface
    this.routes = this.routes.filter(
      (r) =>
        !(
          r.destination === route.destination &&
          r.interface === route.interface &&
          r.namespace === route.namespace
        )
    );

    this.routes.push(route);
    this.sortRoutes();
  }

  /**
   * Remove route from table
   */
  removeRoute(destination: string, iface: string, namespace: string): boolean {
    const initialLength = this.routes.length;
    this.routes = this.routes.filter(
      (r) =>
        !(
          r.destination === destination &&
          r.interface === iface &&
          r.namespace === namespace
        )
    );
    return this.routes.length < initialLength;
  }

  /**
   * Lookup route for destination IP
   * Uses longest prefix matching
   */
  lookup(ip: string, namespace: string): RouteEntry | null {
    // Filter routes for this namespace
    const namespaceRoutes = this.routes.filter((r) => r.namespace === namespace);

    let bestMatch: RouteEntry | null = null;
    let bestPrefixLen = -1;

    for (const route of namespaceRoutes) {
      const match = this.matchesRoute(ip, route.destination);
      if (match !== null && match > bestPrefixLen) {
        bestMatch = route;
        bestPrefixLen = match;
      }
    }

    return bestMatch;
  }

  /**
   * Get all routes for namespace
   */
  getRoutes(namespace?: string): RouteEntry[] {
    if (namespace) {
      return this.routes.filter((r) => r.namespace === namespace);
    }
    return [...this.routes];
  }

  /**
   * Clear all routes
   */
  clear(namespace?: string): void {
    if (namespace) {
      this.routes = this.routes.filter((r) => r.namespace !== namespace);
    } else {
      this.routes = [];
    }
  }

  /**
   * Check if IP matches route destination
   * Returns prefix length if match, null otherwise
   */
  private matchesRoute(ip: string, destination: string): number | null {
    // Parse destination (could be IP or CIDR)
    const [destIP, prefixStr] = destination.split('/');
    const prefixLen = prefixStr ? parseInt(prefixStr, 10) : 32;

    // Special case: default route 0.0.0.0/0
    if (destIP === '0.0.0.0' && prefixLen === 0) {
      return 0;
    }

    // Convert IPs to binary for comparison
    const ipBits = this.ipToBits(ip);
    const destBits = this.ipToBits(destIP);

    if (!ipBits || !destBits) {
      return null;
    }

    // Compare prefix bits
    for (let i = 0; i < prefixLen; i++) {
      if (ipBits[i] !== destBits[i]) {
        return null;
      }
    }

    return prefixLen;
  }

  /**
   * Convert IPv4 address to bit array
   */
  private ipToBits(ip: string): number[] | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return null;
    }

    const bits: number[] = [];
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) {
        return null;
      }

      // Convert byte to 8 bits
      for (let i = 7; i >= 0; i--) {
        bits.push((num >> i) & 1);
      }
    }

    return bits;
  }

  /**
   * Sort routes by prefix length (longest first) then metric
   */
  private sortRoutes(): void {
    this.routes.sort((a, b) => {
      const aPrefixLen = this.getPrefixLength(a.destination);
      const bPrefixLen = this.getPrefixLength(b.destination);

      if (aPrefixLen !== bPrefixLen) {
        return bPrefixLen - aPrefixLen; // Longer prefix first
      }

      return a.metric - b.metric; // Lower metric first
    });
  }

  /**
   * Get prefix length from CIDR notation
   */
  private getPrefixLength(destination: string): number {
    const [, prefixStr] = destination.split('/');
    return prefixStr ? parseInt(prefixStr, 10) : 32;
  }

  /**
   * Format routing table for display
   */
  toString(namespace?: string): string {
    const routes = this.getRoutes(namespace);

    if (routes.length === 0) {
      return 'No routes';
    }

    const lines: string[] = [];
    lines.push('Destination     Gateway         Genmask         Interface  Metric');

    for (const route of routes) {
      const dest = route.destination.padEnd(15);
      const gw = (route.gateway || '*').padEnd(15);
      const genmask = this.cidrToNetmask(route.destination).padEnd(15);
      const iface = route.interface.padEnd(10);
      const metric = route.metric.toString();

      lines.push(`${dest} ${gw} ${genmask} ${iface} ${metric}`);
    }

    return lines.join('\n');
  }

  /**
   * Convert CIDR to netmask
   */
  private cidrToNetmask(cidr: string): string {
    const [, prefixStr] = cidr.split('/');
    const prefixLen = prefixStr ? parseInt(prefixStr, 10) : 32;

    const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
    return [
      (mask >>> 24) & 0xff,
      (mask >>> 16) & 0xff,
      (mask >>> 8) & 0xff,
      mask & 0xff,
    ].join('.');
  }
}
