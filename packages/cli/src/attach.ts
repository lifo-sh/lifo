/**
 * attach.ts — connect the host terminal to a running lifo VM daemon
 *
 * `attachToSession()` is the client side of the daemon connection.
 * It mirrors what `ssh` or `docker attach` do: wire your terminal's
 * stdin/stdout through a socket to the remote shell process.
 *
 * Data flow while attached:
 *
 *   Host stdin  ──► (raw mode keypresses)
 *                     └─► JSON { type:"input", data } ──► socket ──► DaemonTerminal ──► Shell
 *
 *   Shell output ──► DaemonTerminal ──► socket ──► JSON { type:"output", data }
 *                                                       └─► host stdout
 *
 *   SIGWINCH ──► JSON { type:"resize", cols, rows } ──► socket ──► DaemonTerminal
 *
 * Detach behaviour (matching Docker's UX):
 *   - Ctrl+D  → intercepted here, destroys the socket, VM keeps running.
 *   - `exit`  → handled by the daemon shell which calls disconnectAllClients(),
 *               also keeps the VM running (see runDaemon in index.ts).
 *   - `lifo stop <id>` → the only way to actually kill the VM.
 *
 * Transport:
 *   Both Unix-socket attach (local) and TCP attach (remote) use the same
 *   newline-delimited JSON protocol and the same terminal-proxy logic —
 *   only the connection setup differs.
 *
 * Security note (TCP):
 *   TCP attach is unauthenticated in this version — anyone who can reach
 *   the port can attach to the VM. Suitable for local/trusted-network use
 *   only (same as Docker without TLS).
 */

import * as net from 'node:net';
import { readSession } from './session.js';

/**
 * Core terminal-proxy loop: wires the host terminal to an already-connected
 * socket (Unix or TCP). Resolves when the connection closes.
 *
 * Always restores stdin to its original (cooked) mode before returning,
 * even if an error occurs.
 */
/** Maximum lineBuffer size (1 MB). Resets on overflow to prevent memory DoS. */
const MAX_LINE_BUFFER = 1024 * 1024;

async function runAttachOnSocket(socket: net.Socket): Promise<void> {
  // Raw mode: pass keypresses (including Ctrl+C, arrow keys, etc.) through to
  // the daemon shell unchanged, rather than having Node intercept them.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  // Buffer for reassembling split JSON lines from the daemon.
  let lineBuffer = '';

  // ── stdin → socket ──────────────────────────────────────────────────────────
  process.stdin.on('data', (data: string) => {
    if (data === '\x04') {
      // Ctrl+D — detach without forwarding EOF to the daemon shell.
      // The VM continues running; the user is dropped back to the host shell.
      socket.destroy();
      return;
    }
    const msg = JSON.stringify({ type: 'input', data }) + '\n';
    socket.write(msg);
  });

  // ── terminal resize → socket ────────────────────────────────────────────────
  function sendResize() {
    const msg =
      JSON.stringify({ type: 'resize', cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }) + '\n';
    socket.write(msg);
  }
  process.on('SIGWINCH', sendResize);
  // Send current dimensions immediately so the daemon shell sizes correctly.
  sendResize();

  // ── socket → stdout ─────────────────────────────────────────────────────────
  socket.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    // Guard against a runaway daemon sending oversized messages.
    if (lineBuffer.length > MAX_LINE_BUFFER) {
      lineBuffer = '';
      return;
    }
    // Messages are newline-delimited — process every complete line.
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? ''; // last element may be an incomplete line
    for (const line of lines) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'output') {
          process.stdout.write(msg.data);
        }
      } catch {
        // Ignore malformed messages (shouldn't happen in normal operation).
      }
    }
  });

  // ── cleanup on disconnect ───────────────────────────────────────────────────
  return new Promise<void>((resolve) => {
    function cleanup() {
      // Restore stdin to normal (cooked) mode so the host shell works again.
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      // Remove only the listener we registered — not all SIGWINCH listeners.
      process.removeListener('SIGWINCH', sendResize);
    }

    // Socket closed gracefully (daemon called disconnectAllClients or shut down).
    socket.on('close', () => { cleanup(); resolve(); });
    // Socket error (daemon crashed, socket file deleted, etc.).
    socket.on('error', () => { cleanup(); resolve(); });
  });
}

/**
 * Attaches the current host terminal to the VM identified by `id` via its
 * Unix socket. Requires the session to exist in the local session registry.
 *
 * Resolves when the connection closes (Ctrl+D, `exit`, or daemon shutdown).
 */
export async function attachToSession(id: string): Promise<void> {
  const session = readSession(id);
  if (!session) {
    console.error(`No session found with id: ${id}`);
    process.exit(1);
  }

  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(session.socketPath);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('connection timed out after 5 s'));
      }, 5000);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  } catch (err: any) {
    console.error(`Could not connect to session ${id}: ${err.message}`);
    process.exit(1);
  }

  await runAttachOnSocket(socket);
}

/**
 * Attaches the current host terminal to a VM running on a remote (or local)
 * host via a TCP connection. No session registry is needed — just host + port.
 *
 * Example: attachViaTcp('192.168.1.100', 7777)
 *
 * Resolves when the connection closes (Ctrl+D, `exit`, or daemon shutdown).
 *
 * Security note: this connection is unauthenticated. Only use on trusted
 * networks. A future version may add a shared-secret token.
 */
export async function attachViaTcp(host: string, port: number): Promise<void> {
  let socket: net.Socket;
  try {
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(port, host);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('connection timed out after 5 s'));
      }, 5000);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  } catch (err: any) {
    console.error(`Could not connect to ${host}:${port}: ${err.message}`);
    process.exit(1);
  }

  await runAttachOnSocket(socket);
}
