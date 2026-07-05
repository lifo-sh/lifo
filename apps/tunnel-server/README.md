# Lifo Tunnel Server

An ngrok-like tunneling server that enables HTTP requests from the host machine to be forwarded to services running inside the Lifo environment.

## Architecture

```
Host Machine (Port 3005)
         ↓
  Tunnel Server
         ↓
    WebSocket
         ↓
  Tunnel Command (inside Lifo)
         ↓
  Virtual HTTP Server (single port)
```

## Components

### 1. Tunnel Server (`tunnel-server/`)

Runs on the host machine on port 3005. It:

- Accepts HTTP requests on port 3005
- Maintains WebSocket connections with tunnel clients
- Forwards HTTP requests through WebSocket to connected clients
- Returns responses back to the original HTTP requesters

### 2. Tunnel Command (built into Lifo)

Runs inside the Lifo environment. It:

- Connects to the tunnel server via WebSocket
- Routes requests to a specific port in Lifo's virtual environment
- Receives HTTP requests from the tunnel server
- Sends responses back through the WebSocket

## Usage

### Quick Start (Recommended)

**For Vite or other dev servers:**

```bash
# Terminal 1: Start tunnel server targeting port 5173
cd apps/tunnel-server
node server.js --port 5173

# Terminal 2: Start Lifo and run your app
lifo
> cd my-vite-app
> npm run dev  # Starts Vite on port 5173
> tunnel       # Connect to tunnel server

# Access from anywhere:
# Open browser: http://localhost:3005
# Your Vite app is live!
```

The key benefit: You configure the port once on the server side with `--port 5173`, then access your app directly at `http://localhost:3005` without any path prefixes!

### 1. Start the Tunnel Server (on host machine)

**Option A: Tunnel to a specific port (recommended)**
```bash
cd apps/tunnel-server
node server.js --port 5173
```

This configures the server to tunnel all requests to port 5173 inside Lifo.

**Option B: Path-based multi-port mode**
```bash
cd apps/tunnel-server
node server.js
```

This allows tunneling to multiple ports using `/PORT/path` URLs.

### 2. Run the Tunnel Command (inside Lifo)

```bash
lifo
> tunnel
```

The tunnel client will connect to the server and route requests accordingly.

### 3. Access the Tunneled Service

**With --port specified on server:**
```bash
curl http://localhost:3005/              # → Port 5173, path /
curl http://localhost:3005/api/users     # → Port 5173, path /api/users
curl http://localhost:3005/assets/main.js # → Port 5173, path /assets/main.js
```

**Without --port (path-based mode):**
```bash
curl http://localhost:3005/5173/         # → Port 5173, path /
curl http://localhost:3005/3000/api      # → Port 3000, path /api
```

## Tunnel Modes

### Single Port Mode (Recommended for Dev Servers)

Configure the port on the **server side**:

```bash
# On host machine:
node server.js --port 5173

# In Lifo:
tunnel

# Access from host:
http://localhost:3005/           → Port 5173, path /
http://localhost:3005/src/main.ts → Port 5173, path /src/main.ts
```

Perfect for Vite, webpack-dev-server, Next.js, etc. All requests go directly to the specified port.

### Path-based Multi-Port Mode

Don't specify --port on the server:

```bash
# On host machine:
node server.js

# In Lifo:
tunnel

# Access from host:
http://localhost:3005/3000/      → Port 3000, path /
http://localhost:3005/8080/api   → Port 8080, path /api
```

Use this mode when you need to tunnel multiple ports simultaneously.

## Testing Examples

### Example 1: Vite Dev Server

```bash
# Terminal 1: Start tunnel server with port
cd apps/tunnel-server
node server.js --port 5173

# Terminal 2: Start Lifo and run Vite
lifo
> cd my-vite-app
> npm run dev  # Starts on port 5173
> tunnel

# Terminal 3: Access from host machine
curl http://localhost:3005/
# Your Vite app loads perfectly!
```

### Example 2: Simple HTTP Server

```bash
# Terminal 1: Start tunnel server
cd apps/tunnel-server
node server.js --port 8080

# Terminal 2: Start Lifo and create server
lifo
> node -e "require('http').createServer((req,res) => res.end('Hello World')).listen(8080)"
> tunnel

# Terminal 3: Test
curl http://localhost:3005/
# Output: Hello World
```

### Example 3: Multiple Servers (Path-based)

```bash
# Terminal 1: Start tunnel server WITHOUT --port
cd apps/tunnel-server
node server.js

# Terminal 2: Start Lifo and create multiple servers
lifo
> node -e "require('http').createServer((req,res) => res.end('API')).listen(3000)" &
> node -e "require('http').createServer((req,res) => res.end('Web')).listen(8080)" &
> tunnel

# Terminal 3: Access different ports
curl http://localhost:3005/3000/  # Output: API
curl http://localhost:3005/8080/  # Output: Web
```

## Features

- Real-time request/response tunneling
- WebSocket-based communication
- Automatic reconnection if tunnel client disconnects
- Support for all HTTP methods (GET, POST, PUT, DELETE, etc.)
- Headers and body forwarding
- Base64 encoding for binary data
- Direct URL passthrough (no path rewriting)
- Perfect for modern dev servers (Vite, Next.js, webpack-dev-server)

## Configuration Options

### Server-side (Host Machine)

**Command Line Arguments:**
- `--port <number>`: Tunnel to specific port inside Lifo (e.g., 5173)
- `--server-port <number>`: Port for server to listen on (default: 3005)
- `--host <address>`: Bind address (default: 0.0.0.0)

**Environment Variables:**
- `PORT`: Server listen port (default: 3005)
- `HOST`: Bind address (default: 0.0.0.0)

**Examples:**
```bash
node server.js --port 5173
PORT=8080 node server.js --port 5173
node server.js --port 3000 --server-port 8080
```

### Client-side (Inside Lifo)

The tunnel client connects automatically. No port configuration needed on the client side.

## Notes

- **Port configuration happens on the server side** with `--port` argument
- The tunnel server must be running before starting the tunnel command
- If the tunnel disconnects, it will automatically attempt to reconnect after 5 seconds
- All request/response data is logged to the console for debugging
- Use `node server.js --port 5173` for single-port mode (recommended for dev servers)
- Use `node server.js` without --port for multi-port path-based routing

## Command Reference

### Tunnel Server (Host Machine)

```bash
node server.js --port 5173              # Tunnel to specific port
node server.js                          # Path-based multi-port mode
node server.js --server-port 8080       # Custom server listen port
node server.js --host 192.168.1.100     # Custom bind address
node server.js --help                   # Show help
```

### Tunnel Client (Inside Lifo)

```bash
tunnel                     # Connect to tunnel server
tunnel --server ws://...   # Custom tunnel server URL
tunnel -v                  # Verbose logging
tunnel --help              # Show help
```

Note: The port configuration is done on the **server side** with `node server.js --port 5173`, not on the client side.
