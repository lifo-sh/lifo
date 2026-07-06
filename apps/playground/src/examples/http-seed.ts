import { createDefaultRegistry, createTunnelCommandV2, type Kernel } from '@lifo-sh/core';

/* Seeds the HTTP example's service manager + sample servers. Moved verbatim from the old main.ts bootHttp(). */
export function seedHttp(kernel: Kernel): void {
	const env = kernel.getDefaultEnv();
	const tempRegistry = createDefaultRegistry();
	// Register tunnel command so it's available for service execution
	tempRegistry.register('tunnel', createTunnelCommandV2(kernel));
	kernel.initServiceManager(tempRegistry, env);

	// Create tunnel systemd service unit
	kernel.vfs.mkdir('/etc/systemd/system', { recursive: true });
	kernel.vfs.writeFile('/etc/systemd/system/tunnel.service', `[Unit]
Description=WebSocket Tunnel Service
After=network.target

[Service]
Type=simple
ExecStart=tunnel --server ws://localhost:3005 --port 5173
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`);

	// The tunnel service unit is available (users can `systemctl start tunnel` if
	// they run a relay), but NOT auto-enabled — no relay exists in the browser,
	// so auto-starting only floods the terminal with reconnect errors.

	// Write server.js to VFS
	kernel.vfs.writeFile('/home/user/server.js', `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from Lifo 333!\\n');
});
server.listen(3000, () => {
  console.log('Server running on port 3000');
});
`);


	kernel.vfs.writeFile('/home/user/server2.js', `const http = require('http');

	// Proxy server that forwards all requests to port 3000
	const server = http.createServer((req, res) => {
		// Use synchronous internal API to forward to port 3000
		// This works because both servers are in the same virtual environment
		const proxyRes = http._syncRequest({
			hostname: 'localhost',
			port: 3000,
			path: req.url,
			method: req.method,
			headers: req.headers
		});

		if (proxyRes) {
			// Forward the response from port 3000
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			res.end(proxyRes.body);
			console.log(\`[Proxy] \${req.method} \${req.url} -> 3000 -> \${proxyRes.statusCode}\`);
		} else {
			// Port 3000 is not running
			res.writeHead(502, { 'Content-Type': 'text/plain' });
			res.end('Bad Gateway: Server on port 3000 is not running.\\n');
			console.error('[Proxy] Port 3000 is not available');
		}
	});

	server.listen(3004, () => {
		console.log('Proxy server running on port 3004 (forwarding to 3000)');
		console.log('All requests to 3001 will be tunneled to 3000');
	});
	`);

	kernel.vfs.writeFile('/home/user/server5173.js', `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from Lifo5173!\\n');
});
server.listen(5173, () => {
  console.log('Server running on port 5173');
});
`);
}
