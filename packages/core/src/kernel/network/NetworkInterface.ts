import type {
  NetworkInterface as INetworkInterface,
  InterfaceState,
  InterfaceStats,
  IPAddress,
  Packet,
} from './types.js';

/**
 * Virtual network interface implementation
 * Represents a network device like eth0, lo, tun0, etc.
 */
export class NetworkInterface implements INetworkInterface {
  name: string;
  type: 'loopback' | 'ethernet' | 'tunnel';
  state: InterfaceState;
  mtu: number;
  addresses: IPAddress[];
  mac?: string;
  stats: InterfaceStats;
  namespace: string;

  private packetQueue: Packet[] = [];
  private listeners: ((packet: Packet) => void)[] = [];

  constructor(
    name: string,
    type: 'loopback' | 'ethernet' | 'tunnel',
    namespace: string,
    options?: {
      mtu?: number;
      mac?: string;
      addresses?: IPAddress[];
    }
  ) {
    this.name = name;
    this.type = type;
    this.namespace = namespace;
    this.state = 'down';
    this.mtu = options?.mtu ?? (type === 'loopback' ? 65536 : 1500);
    this.mac = options?.mac ?? (type === 'ethernet' ? this.generateMAC() : undefined);
    this.addresses = options?.addresses ?? [];
    this.stats = {
      rxPackets: 0,
      txPackets: 0,
      rxBytes: 0,
      txBytes: 0,
      rxErrors: 0,
      txErrors: 0,
      rxDropped: 0,
      txDropped: 0,
    };
  }

  /**
   * Bring interface up
   */
  up(): void {
    this.state = 'up';
  }

  /**
   * Bring interface down
   */
  down(): void {
    this.state = 'down';
  }

  /**
   * Add IP address to interface
   */
  addAddress(address: IPAddress): void {
    // Check if address already exists
    const exists = this.addresses.some(
      (a) => a.address === address.address && a.version === address.version
    );
    if (!exists) {
      this.addresses.push(address);
    }
  }

  /**
   * Remove IP address from interface
   */
  removeAddress(address: string): void {
    this.addresses = this.addresses.filter((a) => a.address !== address);
  }

  /**
   * Check if interface has address
   */
  hasAddress(address: string): boolean {
    return this.addresses.some((a) => a.address === address);
  }

  /**
   * Send packet through interface
   */
  send(packet: Packet): void {
    if (this.state === 'down') {
      this.stats.txDropped++;
      throw new Error(`Interface ${this.name} is down`);
    }

    if (packet.data.length > this.mtu) {
      this.stats.txErrors++;
      throw new Error(`Packet size ${packet.data.length} exceeds MTU ${this.mtu}`);
    }

    this.stats.txPackets++;
    this.stats.txBytes += packet.data.length;

    // For loopback, immediately queue for receive
    if (this.type === 'loopback') {
      this.receive(packet);
    } else {
      // For other interfaces, emit packet to listeners
      this.emit(packet);
    }
  }

  /**
   * Receive packet on interface
   */
  receive(packet: Packet): void {
    if (this.state === 'down') {
      this.stats.rxDropped++;
      return;
    }

    this.stats.rxPackets++;
    this.stats.rxBytes += packet.data.length;
    this.packetQueue.push(packet);
    this.emit(packet);
  }

  /**
   * Register packet listener
   */
  onPacket(listener: (packet: Packet) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Emit packet to all listeners
   */
  private emit(packet: Packet): void {
    for (const listener of this.listeners) {
      try {
        listener(packet);
      } catch (error) {
        console.error(`Error in packet listener:`, error);
      }
    }
  }

  /**
   * Get next packet from queue
   */
  nextPacket(): Packet | undefined {
    return this.packetQueue.shift();
  }

  /**
   * Generate random MAC address
   */
  private generateMAC(): string {
    const bytes = new Array(6)
      .fill(0)
      .map(() => Math.floor(Math.random() * 256));

    // Set locally administered bit
    bytes[0] = (bytes[0] & 0xfe) | 0x02;

    return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
  }

  /**
   * Get interface info as string (for ifconfig)
   */
  toString(): string {
    const lines: string[] = [];

    lines.push(`${this.name}: flags=<${this.state.toUpperCase()}> mtu ${this.mtu}`);

    if (this.mac) {
      lines.push(`        ether ${this.mac}`);
    }

    for (const addr of this.addresses) {
      const subnet = addr.subnet ? `/${addr.subnet}` : '';
      lines.push(`        inet${addr.version === 6 ? '6' : ''} ${addr.address}${subnet}`);
    }

    lines.push(
      `        RX packets ${this.stats.rxPackets}  bytes ${this.stats.rxBytes} (${this.formatBytes(this.stats.rxBytes)})`
    );
    lines.push(
      `        RX errors ${this.stats.rxErrors}  dropped ${this.stats.rxDropped}`
    );
    lines.push(
      `        TX packets ${this.stats.txPackets}  bytes ${this.stats.txBytes} (${this.formatBytes(this.stats.txBytes)})`
    );
    lines.push(
      `        TX errors ${this.stats.txErrors}  dropped ${this.stats.txDropped}`
    );

    return lines.join('\n');
  }

  /**
   * Format bytes for display
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  /**
   * Set MTU (Maximum Transmission Unit)
   */
  setMTU(mtu: number): void {
    this.mtu = mtu;
  }

  /**
   * Get interface statistics
   */
  getStats(): InterfaceStats {
    return this.stats;
  }
}
