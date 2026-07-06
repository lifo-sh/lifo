import { createDefaultRegistry, createTunnelCommandV2, type Kernel } from '@lifo-sh/core';
import { viteReactAppFiles } from '@/data/templates/vite-react';

/* Seeds the interactive shell's sample projects + tunnel service. Moved verbatim from the old main.ts bootInteractive(). */
export function seedInteractive(kernel: Kernel): void {
	const env = kernel.getDefaultEnv();
	const tempRegistry = createDefaultRegistry();
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

	// The tunnel service unit is available for users who run a relay + `tunnel`
	// manually, but it is NOT auto-enabled: in the browser there's no relay at
	// ws://localhost:3005, so starting it just floods the terminal with
	// reconnect errors. The service worker is the browser transport.
	//
	// This example persists its VFS (persist: true), so a returning visitor may
	// still carry a `multi-user.target.wants/tunnel.service` entry written by a
	// PRE-FIX build — which bootServices() would auto-start. Proactively disable
	// it to clear any such stale enablement.
	kernel.serviceManager?.disable('tunnel');

	// Create sample Vite app for testing
	const vfs = kernel.vfs;
	vfs.mkdir('/home/user/vite-project', { recursive: true });
	vfs.writeFile('/home/user/vite-project/package.json', JSON.stringify({
		name: 'vite-project',
		version: '1.0.0',
		type: 'module',
		scripts: {
			dev: 'vite',
			build: 'vite build',
		},
		dependencies: {
			vite: '^7.3.1',
		},
	}, null, 2));

	vfs.writeFile('/home/user/vite-project/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vite App in Lifo</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>`);

	vfs.writeFile('/home/user/vite-project/main.js', `document.getElementById('app').innerHTML = \`
  <h1>Hello from Vite in Lifo! 🚀</h1>
  <p>This Vite dev server is running entirely in your browser!</p>
  <p>Port: <strong>5173</strong></p>
  <p>Try accessing from another tab with: <code>curl localhost:5173</code></p>
\`;

console.log('Vite app loaded successfully!');
`);

	// ── React example (react-app) — shared with the Vite with React sidebar example
	for (const [p, c] of Object.entries(viteReactAppFiles('/home/user/react-app', false))) {
		const dir = p.slice(0, p.lastIndexOf('/'));
		vfs.mkdir(dir, { recursive: true });
		vfs.writeFile(p, c);
	}

	// NOTE: We intentionally DO NOT create vite.config.js because esbuild-wasm
	// cannot handle config file loading in the VFS (directory traversal issues).
	// Users should either:
	// 1. Use vite-direct.js (which sets configFile: false)
	// 2. Use CLI flags: npx vite --port 5173 --host localhost

	// Create a simple test server to verify HTTP registration works
	vfs.writeFile('/home/user/vite-project/test-server.js', `// Simple HTTP server test
// This verifies that virtual HTTP servers work correctly

const http = require('http');

console.log('Creating HTTP server...');
console.log('NOTE: Server must stay running! Do NOT press Ctrl+C');
console.log('Open a NEW tab (+) to test with "ports" and "curl"');
console.log('');

const server = http.createServer((req, res) => {
  console.log(\`✅ Request received: \${req.method} \${req.url}\`);

  res.writeHead(200, {
    'Content-Type': 'text/html',
    'X-Powered-By': 'Lifo Virtual HTTP'
  });

  res.end(\`<!DOCTYPE html>
<html>
<head><title>Test Server</title></head>
<body>
  <h1>✅ HTTP Server Works!</h1>
  <p>Port: <strong>3000</strong></p>
  <p>This proves the virtual HTTP server is registered correctly.</p>
  <p>Try: <code>curl localhost:3000</code> from another tab</p>
  <p>Or visit: <a href="/api/proxy/3000/">/api/proxy/3000/</a></p>
</body>
</html>\`);
});

console.log('Starting server on port 3000...');

server.listen(3000, () => {
  console.log('');
  console.log('🎉 ===================================');
  console.log('🎉 Server is RUNNING on port 3000!');
  console.log('🎉 ===================================');
  console.log('');
  console.log('Test commands IN A NEW TAB (+):');
  console.log('  1. ports');
  console.log('  2. curl localhost:3000');
  console.log('');
  console.log('⚠️  IMPORTANT: Keep this tab running!');
  console.log('⚠️  Do NOT close or stop this process');
  console.log('');
});

server.on('error', (err) => {
  console.error('❌ Server error:', err.message);
});

// Keep the process alive
setInterval(() => {
  // Noop to prevent process exit
}, 60000);
`);

	// Create direct Vite runner that doesn't use npm
	vfs.writeFile('/home/user/vite-project/vite-direct.js', `#!/usr/bin/env node
// Direct Vite runner - runs Vite without npm spawning a child process
// This keeps the server process alive so ports stay registered

console.log('🚀 Starting Vite directly...');
console.log('');

// Import and run Vite's CLI directly
async function startVite() {
  try {
    // Dynamically import Vite
    const vite = await import('vite');

    console.log('📦 Vite imported successfully');
    console.log('⚙️  Creating dev server...');

    // Create Vite dev server
    const server = await vite.createServer({
      configFile: false, // Skip config file to avoid esbuild issues in VFS
      root: process.cwd(),
      server: {
        port: 5173,
        host: 'localhost',
      },
    });

    console.log('🎯 Starting server on port 5173...');
    await server.listen();

    const info = server.config.logger.info;
    info('');
    info('  ✅ Vite dev server is running!');
    info('');
    info('  Test in another tab:');
    info('    1. ports');
    info('    2. curl localhost:5173');
    info('');
    info('  ⚠️  Keep this tab open - do NOT stop the process!');
    info('');

    // Keep process alive - wait for server close
    await new Promise((resolve) => {
      server.httpServer?.on('close', resolve);
    });

  } catch (error) {
    console.error('❌ Error starting Vite:', error.message);
    console.error('');
    console.error('Vite may not be installed. Try:');
    console.error('  npm install vite');
    console.error('');
    console.error('Or use the test server instead:');
    console.error('  node test-server.js');
    process.exit(1);
  }
}

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err);
});

// Start Vite
startVite().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
`);

	vfs.writeFile('/home/user/vite-project/README.md', `# Vite Project in Lifo

⚠️ **IMPORTANT**: Use \`node vite-direct.js\` to run Vite (NOT \`npm run dev\`)

## Quick Start

### Step 1: Test Basic HTTP Server (START HERE!)
\`\`\`bash
cd vite-project
node test-server.js
\`\`\`

**Leave this running!** Open a NEW tab (+) and run:
\`\`\`bash
ports          # Should show port 3000
curl localhost:3000
\`\`\`

If this works, HTTP is working correctly! ✅

### Step 2: Run Vite Directly (Recommended)
\`\`\`bash
node vite-direct.js
\`\`\`

This runs Vite without a config file, avoiding esbuild issues in the VFS.

**Alternative methods:**
\`\`\`bash
# Using npm with CLI flags (also works)
npm run dev

# Manual with CLI flags
npx vite --port 5173 --host localhost
\`\`\`

### Step 3: Access the Server (in another tab)

\`\`\`bash
ports          # Should show port 5173
curl localhost:5173
\`\`\`

Or browser: http://localhost:3000/api/proxy/5173/

## Why node vite-direct.js?

1. **No config file loading**: Avoids esbuild-wasm directory traversal issues
2. **Process stays alive**: Runs Vite in the same process, keeping ports registered
3. **Better control**: Inline configuration, easier to debug

## Troubleshooting

### "No ports registered" after starting server
- The process exited and cleaned up the port
- Use \`node vite-direct.js\` instead of \`npm run dev\`
- Check console for \`[lifo-http] ❌ Server.close()\` messages

### Test if kernel is shared between tabs
\`\`\`bash
# Tab 1:
test-registry set

# Tab 2:
test-registry get    # Should show "Has port: true"
\`\`\`

## How It Works

1. **Virtual HTTP Server**: Uses node-compat's virtual HTTP implementation
2. **Port Registry**: Servers register in kernel.portRegistry[port]
3. **Process Lifetime**: Server must stay running to keep port registered
4. **Port Bridge**: Vite dev server plugin proxies to virtual ports

Enjoy your browser-native development server! 🚀
`);
}
