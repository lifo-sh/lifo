import type {
  Socket as ISocket,
  SocketType,
  SocketState,
  SocketAddress,
  Packet,
} from './types.js';

/**
 * Virtual socket implementation
 * Mimics POSIX socket API
 */
export class Socket implements ISocket {
  fd: number;
  type: SocketType;
  state: SocketState;
  localAddress?: SocketAddress;
  remoteAddress?: SocketAddress;
  namespace: string;

  private receiveQueue: Uint8Array[] = [];
  private acceptQueue: Socket[] = [];
  private backlog = 0;
  private receiveWaiters: ((data: Uint8Array) => void)[] = [];
  private acceptWaiters: ((socket: Socket) => void)[] = [];
  private closeCallback?: () => void;

  constructor(
    fd: number,
    type: SocketType,
    namespace: string,
    closeCallback?: () => void
  ) {
    this.fd = fd;
    this.type = type;
    this.namespace = namespace;
    this.state = 'closed';
    this.closeCallback = closeCallback;
  }

  /**
   * Bind socket to address
   */
  bind(address: SocketAddress): void {
    if (this.state !== 'closed') {
      throw new Error('Socket already bound or connected');
    }

    this.localAddress = address;
  }

  /**
   * Connect to remote address
   */
  async connect(address: SocketAddress): Promise<void> {
    if (this.state !== 'closed') {
      throw new Error('Socket already bound or connected');
    }

    if (!this.localAddress) {
      // Auto-assign local address
      this.localAddress = {
        ip: '0.0.0.0',
        port: this.allocateEphemeralPort(),
      };
    }

    this.remoteAddress = address;
    this.state = 'syn-sent';

    // Simulate TCP handshake delay
    await new Promise((resolve) => setTimeout(resolve, 1));

    this.state = 'established';
  }

  /**
   * Listen for connections
   */
  listen(backlog = 128): void {
    if (!this.localAddress) {
      throw new Error('Socket must be bound before listening');
    }

    if (this.type !== 'tcp') {
      throw new Error('Only TCP sockets can listen');
    }

    this.backlog = backlog;
    this.state = 'listen';
  }

  /**
   * Accept incoming connection
   */
  async accept(): Promise<Socket> {
    if (this.state !== 'listen') {
      throw new Error('Socket is not listening');
    }

    // Check if connection is already in queue
    const existing = this.acceptQueue.shift();
    if (existing) {
      return existing;
    }

    // Wait for incoming connection
    return new Promise((resolve) => {
      this.acceptWaiters.push(resolve);
    });
  }

  /**
   * Send data through socket
   */
  async send(data: Uint8Array): Promise<number> {
    if (this.state !== 'established') {
      throw new Error(`Cannot send: socket is ${this.state}`);
    }

    if (!this.remoteAddress || !this.localAddress) {
      throw new Error('Socket not connected');
    }

    // In a real implementation, this would fragment and send packets
    // For now, we just simulate the send
    return data.length;
  }

  /**
   * Receive data from socket
   */
  async recv(maxBytes: number): Promise<Uint8Array> {
    if (this.state !== 'established' && this.state !== 'close-wait') {
      throw new Error(`Cannot receive: socket is ${this.state}`);
    }

    // Check if data is already in queue
    const existing = this.receiveQueue.shift();
    if (existing) {
      return existing.slice(0, maxBytes);
    }

    // Wait for data
    return new Promise((resolve) => {
      this.receiveWaiters.push((data) => {
        resolve(data.slice(0, maxBytes));
      });
    });
  }

  /**
   * Close socket
   */
  close(): void {
    if (this.state === 'closed') {
      return;
    }

    if (this.state === 'established') {
      this.state = 'fin-wait';
      // Simulate FIN handshake
      setTimeout(() => {
        this.state = 'closed';
      }, 1);
    } else {
      this.state = 'closed';
    }

    // Clear queues
    this.receiveQueue = [];
    this.acceptQueue = [];
    this.receiveWaiters = [];
    this.acceptWaiters = [];

    // Notify close callback
    if (this.closeCallback) {
      this.closeCallback();
    }
  }

  /**
   * Deliver packet to socket (called by NetworkStack)
   */
  deliverPacket(packet: Packet): void {
    if (this.state === 'listen') {
      // New connection attempt
      const clientSocket = new Socket(
        this.allocateEphemeralFd(),
        this.type,
        this.namespace
      );
      clientSocket.state = 'established';
      clientSocket.localAddress = this.localAddress;
      clientSocket.remoteAddress = packet.source;

      // Add to accept queue or notify waiter
      if (this.acceptWaiters.length > 0) {
        const waiter = this.acceptWaiters.shift()!;
        waiter(clientSocket);
      } else if (this.acceptQueue.length < this.backlog) {
        this.acceptQueue.push(clientSocket);
      }
      // else: connection refused (queue full)
    } else if (this.state === 'established' || this.state === 'close-wait') {
      // Data packet
      if (this.receiveWaiters.length > 0) {
        const waiter = this.receiveWaiters.shift()!;
        waiter(packet.data);
      } else {
        this.receiveQueue.push(packet.data);
      }
    }
  }

  /**
   * Allocate ephemeral port (49152-65535)
   */
  private allocateEphemeralPort(): number {
    return 49152 + Math.floor(Math.random() * (65535 - 49152));
  }

  /**
   * Allocate ephemeral file descriptor
   */
  private allocateEphemeralFd(): number {
    return 100 + Math.floor(Math.random() * 900);
  }

  /**
   * Get socket info string (for netstat)
   */
  toString(): string {
    const proto = this.type.toUpperCase().padEnd(5);
    const local = this.localAddress
      ? `${this.localAddress.ip}:${this.localAddress.port}`
      : '*:*';
    const remote = this.remoteAddress
      ? `${this.remoteAddress.ip}:${this.remoteAddress.port}`
      : '*:*';
    const state = this.state.toUpperCase();

    return `${proto} ${local.padEnd(22)} ${remote.padEnd(22)} ${state}`;
  }
}
