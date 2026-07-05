import type { VirtualRequestHandler, VirtualRequest, VirtualResponse } from '../index.js';

/**
 * Port Bridge - Bridges virtual ports to real host network
 * Allows accessing virtual HTTP servers from the host machine
 */
export class PortBridge {
  private portRegistry: Map<number, VirtualRequestHandler>;
  private forwardedPorts = new Map<number, number>(); // virtual -> real

  constructor(portRegistry: Map<number, VirtualRequestHandler>) {
    this.portRegistry = portRegistry;
  }

  /**
   * Forward a virtual port to the real host network
   * Returns a URL that can be accessed from the host browser
   */
  forward(virtualPort: number): string {
    // In browser: create a service worker or proxy endpoint
    // For now, return a special URL that can be handled
    const realPort = this.findAvailablePort();
    this.forwardedPorts.set(virtualPort, realPort);

    // Return URL that can be accessed via proxy
    return `http://localhost:${realPort}`;
  }

  /**
   * Stop forwarding a port
   */
  unforward(virtualPort: number): boolean {
    return this.forwardedPorts.delete(virtualPort);
  }

  /**
   * Handle a real HTTP request and forward to virtual port
   */
  async handleRequest(
    realPort: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    // Find virtual port for this real port
    let virtualPort: number | undefined;
    for (const [vPort, rPort] of this.forwardedPorts.entries()) {
      if (rPort === realPort) {
        virtualPort = vPort;
        break;
      }
    }

    if (!virtualPort) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'text/plain' },
        body: 'Bad Gateway: Port not forwarded\n',
      };
    }

    // Get handler from port registry
    const handler = this.portRegistry.get(virtualPort);
    if (!handler) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'text/plain' },
        body: `Bad Gateway: No service on virtual port ${virtualPort}\n`,
      };
    }

    // Forward request to virtual server
    const virtualReq: VirtualRequest = {
      method,
      url: path,
      headers,
      body,
    };

    const virtualRes: VirtualResponse = {
      statusCode: 200,
      headers: {},
      body: '',
    };

    try {
      handler(virtualReq, virtualRes);
      return virtualRes;
    } catch (error) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/plain' },
        body: `Internal Server Error: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }

  /**
   * Get all forwarded ports
   */
  getForwardedPorts(): Array<{ virtual: number; real: number }> {
    return Array.from(this.forwardedPorts.entries()).map(([virtual, real]) => ({
      virtual,
      real,
    }));
  }

  /**
   * Create a simple browser-accessible proxy endpoint
   * Returns HTML with a link to access the virtual server
   */
  createAccessPage(virtualPort: number): string {
    const info = this.forwardedPorts.get(virtualPort);
    if (!info) {
      return '<html><body><h1>Port not forwarded</h1></body></html>';
    }

    return `
<!DOCTYPE html>
<html>
<head>
  <title>Lifo Port Forward - Port ${virtualPort}</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1b26; color: #a9b1d6; }
    h1 { color: #7aa2f7; }
    .endpoint { background: #24283b; padding: 15px; border-radius: 5px; margin: 10px 0; }
    .url { color: #9ece6a; }
    button { background: #7aa2f7; color: #1a1b26; border: none; padding: 10px 20px; cursor: pointer; border-radius: 3px; font-size: 14px; }
    button:hover { background: #89ddff; }
    #output { background: #24283b; padding: 15px; border-radius: 5px; margin-top: 20px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>🚇 Lifo Port Forward</h1>
  <p>Virtual port <strong>${virtualPort}</strong> is now accessible from your host machine</p>

  <div class="endpoint">
    <p><strong>Proxy Endpoint:</strong></p>
    <p class="url">/api/proxy/${virtualPort}/*</p>
  </div>

  <button onclick="testConnection()">Test Connection</button>

  <div id="output"></div>

  <script>
    async function testConnection() {
      const output = document.getElementById('output');
      output.textContent = 'Connecting to virtual port ${virtualPort}...\\n';

      try {
        const response = await fetch('/api/proxy/${virtualPort}/');
        const text = await response.text();
        output.textContent += 'Status: ' + response.status + '\\n';
        output.textContent += 'Response:\\n' + text;
      } catch (error) {
        output.textContent += 'Error: ' + error.message;
      }
    }
  </script>
</body>
</html>
    `;
  }

  /**
   * Find an available real port number
   */
  private findAvailablePort(): number {
    // Start from 8080 and find first available
    let port = 8080;
    const usedPorts = new Set(this.forwardedPorts.values());

    while (usedPorts.has(port)) {
      port++;
    }

    return port;
  }

  /**
   * Create a simple in-browser proxy using fetch
   * This allows accessing virtual servers via URLs like /proxy/3000/
   */
  installBrowserProxy(): void {
    // This would be implemented in the app layer
    // by setting up route handlers in the Vite app
    console.log('[PortBridge] Browser proxy ready');
  }
}
