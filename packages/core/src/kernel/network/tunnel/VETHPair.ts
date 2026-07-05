import type { Packet } from '../types.js';
import { NetworkInterface } from '../NetworkInterface.js';
import type { NetworkStack } from '../NetworkStack.js';

/**
 * VETH Pair - Virtual Ethernet Device Pair
 *
 * Creates two virtual network interfaces that are directly connected.
 * Packets sent to one end appear immediately on the other end.
 * Like a virtual Ethernet cable connecting two namespaces.
 *
 * Example:
 *   ip link add veth0 type veth peer name veth1
 *   ip link set veth1 netns container1
 */
export class VETHPair {
  id: string;
  veth0: NetworkInterface;
  veth1: NetworkInterface;
  state: 'up' | 'down' = 'down';

  private networkStack: NetworkStack;

  // Packet queues for each end
  private queue0: Packet[] = [];
  private queue1: Packet[] = [];
  private waiters0: Array<(packet: Packet) => void> = [];
  private waiters1: Array<(packet: Packet) => void> = [];

  constructor(
    id: string,
    name0: string,
    name1: string,
    networkStack: NetworkStack,
    namespace0 = 'default',
    namespace1 = 'default'
  ) {
    this.id = id;
    this.networkStack = networkStack;

    // Create the two peer interfaces
    this.veth0 = new NetworkInterface(name0, 'ethernet', namespace0);
    this.veth1 = new NetworkInterface(name1, 'ethernet', namespace1);

    // Generate unique MAC addresses for each end
    this.veth0.mac = this.generateMAC(0);
    this.veth1.mac = this.generateMAC(1);
  }

  /**
   * Bring both interfaces up
   */
  async up(): Promise<void> {
    if (this.state === 'up') {
      return;
    }

    this.veth0.up();
    this.veth1.up();
    this.state = 'up';
  }

  /**
   * Bring both interfaces down
   */
  async down(): Promise<void> {
    if (this.state === 'down') {
      return;
    }

    this.veth0.down();
    this.veth1.down();
    this.state = 'down';
  }

  /**
   * Send packet from veth0 to veth1
   */
  async send0to1(packet: Packet): Promise<void> {
    if (this.state === 'down' || this.veth1.state === 'down') {
      throw new Error('VETH peer is down');
    }

    // Update TX stats on veth0
    const stats0 = this.veth0.getStats();
    stats0.txPackets++;
    stats0.txBytes += packet.data.length;

    // Update RX stats on veth1
    const stats1 = this.veth1.getStats();
    stats1.rxPackets++;
    stats1.rxBytes += packet.data.length;

    // Deliver to veth1
    if (this.waiters1.length > 0) {
      const waiter = this.waiters1.shift()!;
      waiter(packet);
    } else {
      this.queue1.push(packet);
    }
  }

  /**
   * Send packet from veth1 to veth0
   */
  async send1to0(packet: Packet): Promise<void> {
    if (this.state === 'down' || this.veth0.state === 'down') {
      throw new Error('VETH peer is down');
    }

    // Update TX stats on veth1
    const stats1 = this.veth1.getStats();
    stats1.txPackets++;
    stats1.txBytes += packet.data.length;

    // Update RX stats on veth0
    const stats0 = this.veth0.getStats();
    stats0.rxPackets++;
    stats0.rxBytes += packet.data.length;

    // Deliver to veth0
    if (this.waiters0.length > 0) {
      const waiter = this.waiters0.shift()!;
      waiter(packet);
    } else {
      this.queue0.push(packet);
    }
  }

  /**
   * Receive packet on veth0 (sent from veth1)
   */
  async recv0(): Promise<Packet> {
    if (this.state === 'down') {
      throw new Error('VETH pair is down');
    }

    if (this.queue0.length > 0) {
      return this.queue0.shift()!;
    }

    return new Promise((resolve) => {
      this.waiters0.push(resolve);
    });
  }

  /**
   * Receive packet on veth1 (sent from veth0)
   */
  async recv1(): Promise<Packet> {
    if (this.state === 'down') {
      throw new Error('VETH pair is down');
    }

    if (this.queue1.length > 0) {
      return this.queue1.shift()!;
    }

    return new Promise((resolve) => {
      this.waiters1.push(resolve);
    });
  }

  /**
   * Move one end of the VETH pair to a different namespace
   */
  async moveToNamespace(which: 0 | 1, namespace: string): Promise<void> {
    const iface = which === 0 ? this.veth0 : this.veth1;

    // Remove from old namespace
    const oldNs = this.networkStack.getNamespace(iface.namespace);
    if (oldNs) {
      oldNs.removeInterface(iface.name);
    }

    // Update namespace
    iface.namespace = namespace;

    // Add to new namespace
    const newNs = this.networkStack.getNamespace(namespace);
    if (newNs) {
      newNs.addInterface(iface);
    }
  }

  /**
   * Generate MAC address for VETH interface
   */
  private generateMAC(index: number): string {
    // Use local-admin bit (02:) to indicate virtual interface
    const prefix = '02:00:00:00';
    const idHex = this.id.padStart(4, '0').slice(0, 4);
    const suffix = index === 0 ? '00' : '01';
    return `${prefix}:${idHex.slice(0, 2)}:${suffix}`;
  }

  /**
   * Get VETH pair status string
   */
  toString(): string {
    const name0 = this.veth0.name.padEnd(10);
    const name1 = this.veth1.name.padEnd(10);
    const state = this.state.toUpperCase();
    const ns0 = `ns=${this.veth0.namespace}`;
    const ns1 = `ns=${this.veth1.namespace}`;

    return `${name0} <-> ${name1} [${state}] ${ns0} <-> ${ns1}`;
  }

  /**
   * Get interface by name
   */
  getInterface(name: string): NetworkInterface | null {
    if (this.veth0.name === name) return this.veth0;
    if (this.veth1.name === name) return this.veth1;
    return null;
  }

  /**
   * Get peer interface
   */
  getPeer(name: string): NetworkInterface | null {
    if (this.veth0.name === name) return this.veth1;
    if (this.veth1.name === name) return this.veth0;
    return null;
  }
}
