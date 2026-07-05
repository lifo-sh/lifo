/**
 * Network stack exports
 */

export { NetworkStack } from './NetworkStack.js';
export { NetworkInterface } from './NetworkInterface.js';
export { NetworkNamespace } from './NetworkNamespace.js';
export { RoutingTable } from './RoutingTable.js';
export { DNSResolver } from './DNSResolver.js';
export { Socket } from './Socket.js';

export type {
  IPAddress,
  InterfaceState,
  InterfaceStats,
  NetworkInterface as INetworkInterface,
  RouteEntry,
  SocketType,
  SocketState,
  SocketAddress,
  Socket as ISocket,
  Packet,
  DNSRecordType,
  DNSRecord,
  NetworkNamespace as INetworkNamespace,
  TunnelType,
  NetworkTunnel,
  PortBinding,
} from './types.js';
