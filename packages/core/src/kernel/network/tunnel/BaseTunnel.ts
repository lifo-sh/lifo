import type { NetworkTunnel, Packet, TunnelType } from '../types.js';
import { NetworkInterface } from '../NetworkInterface.js';
import type { NetworkStack } from '../NetworkStack.js';

/**
 * Base class for all tunnel implementations
 * Provides common functionality for tunnel management
 */
export abstract class BaseTunnel implements Omit<NetworkTunnel, 'interface'> {
  id: string;
  abstract type: TunnelType;
  state: 'up' | 'down' = 'down';
  interface: NetworkInterface;
  config: Record<string, unknown>;

  protected networkStack: NetworkStack;
  protected namespace: string;
  protected mtu: number;

  constructor(
    id: string,
    networkStack: NetworkStack,
    namespace = 'default',
    mtu = 1500
  ) {
    this.id = id;
    this.networkStack = networkStack;
    this.namespace = namespace;
    this.mtu = mtu;
    this.config = {};

    // Create tunnel interface
    this.interface = new NetworkInterface(`${this.getTunnelPrefix()}${id}`, 'tunnel', namespace);
    this.interface.setMTU(mtu);
  }

  /**
   * Get tunnel interface name prefix (tun, gre, etc.)
   */
  protected abstract getTunnelPrefix(): string;

  /**
   * Bring tunnel up
   */
  async up(): Promise<void> {
    if (this.state === 'up') {
      return;
    }

    this.interface.up();
    this.state = 'up';

    // Hook into NetworkStack routing
    await this.setupRouting();
  }

  /**
   * Bring tunnel down
   */
  async down(): Promise<void> {
    if (this.state === 'down') {
      return;
    }

    this.interface.down();
    this.state = 'down';

    // Remove from NetworkStack routing
    await this.teardownRouting();
  }

  /**
   * Setup routing for tunnel (override if needed)
   */
  protected async setupRouting(): Promise<void> {
    // Default: no special routing needed
  }

  /**
   * Teardown routing for tunnel (override if needed)
   */
  protected async teardownRouting(): Promise<void> {
    // Default: no cleanup needed
  }

  /**
   * Send packet through tunnel (must be implemented by subclass)
   */
  abstract send(packet: Packet): Promise<void>;

  /**
   * Receive packet from tunnel (must be implemented by subclass)
   */
  abstract recv(): Promise<Packet>;

  /**
   * Update tunnel statistics
   */
  protected updateStats(bytes: number, direction: 'tx' | 'rx', error = false): void {
    const stats = this.interface.getStats();

    if (direction === 'tx') {
      stats.txPackets++;
      stats.txBytes += bytes;
      if (error) stats.txErrors++;
    } else {
      stats.rxPackets++;
      stats.rxBytes += bytes;
      if (error) stats.rxErrors++;
    }
  }

  /**
   * Get tunnel status string
   */
  toString(): string {
    const name = this.interface.name.padEnd(10);
    const type = this.type.toUpperCase().padEnd(8);
    const state = this.state.toUpperCase();
    const mtu = `MTU ${this.mtu}`;

    return `${name} ${type} ${state} ${mtu}`;
  }
}
