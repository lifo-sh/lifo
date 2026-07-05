/**
 * Network layer types and interfaces
 * Implements a virtual network stack similar to Linux
 */

/**
 * IP address (v4 or v6)
 */
export interface IPAddress {
  version: 4 | 6;
  address: string;
  subnet?: string; // CIDR notation (e.g., "24" for /24)
}

/**
 * Network interface state
 */
export type InterfaceState = 'up' | 'down';

/**
 * Network interface statistics
 */
export interface InterfaceStats {
  rxPackets: number;
  txPackets: number;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
}

/**
 * Virtual network interface (like eth0, lo, etc.)
 */
export interface NetworkInterface {
  name: string;
  type: 'loopback' | 'ethernet' | 'tunnel';
  state: InterfaceState;
  mtu: number;
  addresses: IPAddress[];
  mac?: string; // MAC address (for ethernet interfaces)
  stats: InterfaceStats;
  namespace: string; // Network namespace ID
}

/**
 * Routing table entry
 */
export interface RouteEntry {
  destination: string; // IP or CIDR (e.g., "0.0.0.0/0" for default)
  gateway?: string; // Next hop gateway
  interface: string; // Interface name
  metric: number; // Route priority
  namespace: string; // Network namespace ID
}

/**
 * Socket types
 */
export type SocketType = 'tcp' | 'udp' | 'raw';
export type SocketState = 'closed' | 'listen' | 'syn-sent' | 'established' | 'close-wait' | 'fin-wait';

/**
 * Socket address
 */
export interface SocketAddress {
  ip: string;
  port: number;
}

/**
 * Virtual socket
 */
export interface Socket {
  fd: number; // File descriptor
  type: SocketType;
  state: SocketState;
  localAddress?: SocketAddress;
  remoteAddress?: SocketAddress;
  namespace: string;

  // Socket operations
  bind(address: SocketAddress): void;
  connect(address: SocketAddress): Promise<void>;
  listen(backlog?: number): void;
  accept(): Promise<Socket>;
  send(data: Uint8Array): Promise<number>;
  recv(maxBytes: number): Promise<Uint8Array>;
  close(): void;
  deliverPacket(packet: Packet): void;
  toString(): string;
}

/**
 * Network packet
 */
export interface Packet {
  source: SocketAddress;
  destination: SocketAddress;
  protocol: SocketType;
  data: Uint8Array;
  timestamp: number;
}

/**
 * DNS record types
 */
export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';

/**
 * DNS record
 */
export interface DNSRecord {
  type: DNSRecordType;
  name: string;
  value: string;
  ttl: number;
}

/**
 * Network namespace
 */
export interface NetworkNamespace {
  id: string;
  name: string;
  interfaces: Map<string, NetworkInterface>;
  routes: RouteEntry[];
  sockets: Map<number, Socket>;
  arpTable: Map<string, string>; // IP -> MAC
}

/**
 * Tunnel types
 */
export type TunnelType = 'ssh' | 'gre' | 'ipip' | 'vxlan';

/**
 * SSH tunnel configuration
 */
export interface SSHTunnelConfig {
  type: 'local' | 'remote' | 'dynamic';
  localAddress: SocketAddress;
  remoteAddress: SocketAddress;
  sshHost: string;
  sshPort: number;
  sshUser?: string;
  sshKey?: string;
}

/**
 * Network tunnel
 */
export interface NetworkTunnel {
  id: string;
  type: TunnelType;
  state: 'up' | 'down';
  interface: NetworkInterface;
  config: SSHTunnelConfig | Record<string, unknown>;

  // Tunnel operations
  up(): Promise<void>;
  down(): Promise<void>;
  send(packet: Packet): Promise<void>;
  recv(): Promise<Packet>;
}

/**
 * Port binding
 */
export interface PortBinding {
  port: number;
  address: string;
  protocol: SocketType;
  handler: (socket: Socket) => void | Promise<void>;
  namespace: string;
}
