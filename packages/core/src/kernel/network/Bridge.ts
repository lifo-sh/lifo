import type { Packet } from './types.js';
import { NetworkInterface } from './NetworkInterface.js';
import type { NetworkStack } from './NetworkStack.js';

/**
 * Bridge Device - Virtual Network Switch (like Linux bridge)
 *
 * Acts as a Layer 2 switch, forwarding packets between connected interfaces.
 * Similar to Linux 'ip link add br0 type bridge' or Docker's docker0 bridge.
 *
 * Example:
 *   ip link add br0 type bridge
 *   ip link set veth0 master br0
 *   ip link set veth1 master br0
 */
export class Bridge {
  name: string;
  interface: NetworkInterface;
  state: 'up' | 'down' = 'down';

  // Connected interfaces (bridge ports)
  private ports = new Map<string, NetworkInterface>(); // interface name -> interface

  // MAC address learning table (like a real switch)
  private macTable = new Map<string, string>(); // MAC -> interface name

  // Forwarding database aging time (seconds)
  private ageingTime = 300;

  // Last seen timestamps for MAC addresses
  private lastSeen = new Map<string, number>(); // MAC -> timestamp

  constructor(name: string, _networkStack: NetworkStack, namespace = 'default') {
    this.name = name;

    // Create bridge interface
    this.interface = new NetworkInterface(name, 'ethernet', namespace);
    this.interface.mac = this.generateBridgeMAC();
  }

  /**
   * Bring bridge up
   */
  async up(): Promise<void> {
    if (this.state === 'up') {
      return;
    }

    this.interface.up();
    this.state = 'up';

    // Bring up all connected ports
    for (const port of this.ports.values()) {
      port.up();
    }
  }

  /**
   * Bring bridge down
   */
  async down(): Promise<void> {
    if (this.state === 'down') {
      return;
    }

    this.interface.down();
    this.state = 'down';

    // Don't bring down ports - they stay up
  }

  /**
   * Add interface to bridge (make it a bridge port)
   */
  addPort(iface: NetworkInterface): void {
    if (this.ports.has(iface.name)) {
      throw new Error(`Interface ${iface.name} already connected to bridge`);
    }

    this.ports.set(iface.name, iface);

    // Set interface as bridge port
    // In real Linux, this changes interface behavior
    // Here we just track it
  }

  /**
   * Remove interface from bridge
   */
  removePort(ifaceName: string): boolean {
    if (!this.ports.has(ifaceName)) {
      return false;
    }

    this.ports.delete(ifaceName);

    // Remove MAC entries for this interface
    for (const [mac, port] of this.macTable.entries()) {
      if (port === ifaceName) {
        this.macTable.delete(mac);
        this.lastSeen.delete(mac);
      }
    }

    return true;
  }

  /**
   * Get all bridge ports
   */
  getPorts(): NetworkInterface[] {
    return Array.from(this.ports.values());
  }

  /**
   * Check if interface is a bridge port
   */
  hasPort(ifaceName: string): boolean {
    return this.ports.has(ifaceName);
  }

  /**
   * Forward packet through bridge (like a network switch)
   *
   * This is the core bridge logic:
   * 1. Learn source MAC address
   * 2. Look up destination MAC in forwarding table
   * 3. Forward to specific port or flood to all ports
   */
  async forward(packet: Packet, ingressPort: string): Promise<void> {
    if (this.state === 'down') {
      return;
    }

    // Extract source and destination from packet
    // In a real implementation, we'd parse Ethernet frame
    // For now, we use a simplified model

    const sourceMac = this.getSourceMAC(packet, ingressPort);
    const destMac = this.getDestMAC(packet);

    // Learn source MAC address
    this.learn(sourceMac, ingressPort);

    // Look up destination in forwarding table
    const egressPort = this.macTable.get(destMac);

    if (egressPort && egressPort !== ingressPort) {
      // Unicast: Forward to specific port
      await this.forwardToPort(packet, egressPort);
    } else if (!egressPort) {
      // Unknown destination: Flood to all ports except ingress
      await this.flood(packet, ingressPort);
    }
    // If egressPort === ingressPort, drop packet (same port)
  }

  /**
   * Learn MAC address -> port mapping
   */
  private learn(mac: string, port: string): void {
    this.macTable.set(mac, port);
    this.lastSeen.set(mac, Date.now());

    // Age out old entries
    this.ageEntries();
  }

  /**
   * Forward packet to specific port
   */
  private async forwardToPort(packet: Packet, portName: string): Promise<void> {
    const port = this.ports.get(portName);
    if (!port || port.state === 'down') {
      return;
    }

    // Send packet to interface
    port.send(packet);

    // Update bridge stats
    const stats = this.interface.getStats();
    stats.txPackets++;
    stats.txBytes += packet.data.length;
  }

  /**
   * Flood packet to all ports except ingress
   */
  private async flood(packet: Packet, ingressPort: string): Promise<void> {
    for (const [portName, port] of this.ports.entries()) {
      if (portName === ingressPort) {
        continue; // Don't send back to ingress port
      }

      if (port.state === 'down') {
        continue;
      }

      // Send packet to port
      port.send(packet);
    }

    // Update bridge stats
    const stats = this.interface.getStats();
    stats.txPackets += this.ports.size - 1;
    stats.txBytes += packet.data.length * (this.ports.size - 1);
  }

  /**
   * Age out old MAC table entries
   */
  private ageEntries(): void {
    const now = Date.now();
    const ageingMs = this.ageingTime * 1000;

    for (const [mac, lastSeenTime] of this.lastSeen.entries()) {
      if (now - lastSeenTime > ageingMs) {
        this.macTable.delete(mac);
        this.lastSeen.delete(mac);
      }
    }
  }

  /**
   * Get source MAC from packet (simplified)
   */
  private getSourceMAC(_packet: Packet, ingressPort: string): string {
    const port = this.ports.get(ingressPort);
    return port?.mac || `unknown:${ingressPort}`;
  }

  /**
   * Get destination MAC from packet (simplified)
   */
  private getDestMAC(_packet: Packet): string {
    // In real implementation, parse Ethernet frame
    // For now, return broadcast MAC to trigger flooding
    return 'ff:ff:ff:ff:ff:ff';
  }

  /**
   * Show bridge MAC address table
   */
  showFdb(): string[] {
    const lines: string[] = [];
    lines.push('port name\tmac addr\t\tis local?');

    for (const [mac, port] of this.macTable.entries()) {
      const age = Math.floor((Date.now() - (this.lastSeen.get(mac) || 0)) / 1000);
      lines.push(`${port}\t\t${mac}\t\tno (age ${age}s)`);
    }

    // Show local MACs (bridge interface and ports)
    if (this.interface.mac) {
      lines.push(`${this.name}\t\t${this.interface.mac}\t\tyes`);
    }

    for (const [portName, port] of this.ports.entries()) {
      if (port.mac) {
        lines.push(`${portName}\t\t${port.mac}\t\tyes`);
      }
    }

    return lines;
  }

  /**
   * Get bridge status string
   */
  toString(): string {
    const state = this.state.toUpperCase();
    const ports = this.ports.size;
    const macs = this.macTable.size;

    return `${this.name}: <${state}> ports=${ports} macs=${macs} ageing=${this.ageingTime}s`;
  }

  /**
   * Get detailed bridge info
   */
  getInfo(): string[] {
    const lines: string[] = [];

    lines.push(`Bridge: ${this.name}`);
    lines.push(`  State: ${this.state}`);
    lines.push(`  MAC: ${this.interface.mac || 'none'}`);
    lines.push(`  Ports: ${this.ports.size}`);

    if (this.ports.size > 0) {
      lines.push('');
      lines.push('  Connected ports:');
      for (const [portName, port] of this.ports.entries()) {
        const portState = port.state.toUpperCase();
        lines.push(`    - ${portName} (${portState})`);
      }
    }

    lines.push('');
    lines.push(`  MAC table: ${this.macTable.size} entries`);
    lines.push(`  Ageing time: ${this.ageingTime}s`);

    return lines;
  }

  /**
   * Set ageing time
   */
  setAgeingTime(seconds: number): void {
    this.ageingTime = seconds;
  }

  /**
   * Clear MAC table
   */
  clearFdb(): void {
    this.macTable.clear();
    this.lastSeen.clear();
  }

  /**
   * Generate MAC address for bridge
   */
  private generateBridgeMAC(): string {
    // Linux bridges use locally administered MAC addresses
    // First byte: 02 (locally administered, unicast)
    return `02:00:00:00:br:${this.name.charCodeAt(0).toString(16).padStart(2, '0')}`;
  }

  /**
   * Get statistics
   */
  getStats() {
    return this.interface.getStats();
  }
}
