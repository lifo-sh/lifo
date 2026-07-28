/**
 * session.ts — boot a real lifo session and talk to it, for the CLI tests.
 *
 * The CLI is spawned as a child process rather than imported: `index.ts` calls
 * `main()` at import time, and more importantly the thing worth testing is the
 * entry point as a user invokes it. Two bugs shipped because nothing ever did
 * that — `new Shell()` missing an argument, and `ps` handed the wrong object.
 *
 * Runs through `tsx` so a test loop needs no build step.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(HERE, '../../dist/index.js');
const SESSIONS_DIR = path.join(os.homedir(), '.lifo', 'sessions');

/** Strip ANSI so assertions read the text a user sees. */
export const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*[a-zA-Z]/g, '');

export interface Session {
  id: string;
  socketPath: string;
  /** Host directory mounted at /mnt/host. */
  mountDir: string;
  /** Everything the daemon wrote to stderr — where a boot crash shows up. */
  stderr(): string;
  alive(): boolean;
  /** Type a line into the shell and collect what comes back. */
  run(command: string, settleMs?: number): Promise<string>;
  stop(): Promise<void>;
}

let counter = 0;

/**
 * Boot a detached daemon and wait for its socket.
 *
 * Uses the internal `--daemon` flag directly rather than `--detach`, so the test
 * owns the child process and can read its stderr — `--detach` forks away and the
 * failure output would be lost.
 */
export async function startSession(options: { expose?: string[] } = {}): Promise<Session> {
  const id = `t${process.pid.toString(36)}${(counter++).toString(36)}`;
  const mountDir = fs.mkdtempSync(path.join(os.tmpdir(), `lifo-test-${id}-`));
  const socketPath = path.join(SESSIONS_DIR, `${id}.sock`);

  const args = [CLI_ENTRY, '--daemon', '--id', id, '--mount', mountDir];
  for (const spec of options.expose ?? []) args.push('--expose', spec);

  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(`${CLI_ENTRY} is missing — build the CLI first (pnpm --filter lifo-sh build).`);
  }

  // NODE_OPTIONS must NOT be inherited: vitest puts its own module loader there,
  // and a child booting under it resolves `browser-metro` differently, failing an
  // ESM named-export check that a plain `node dist/index.js` passes. The child has
  // to run the way a user's shell would, not the way a test worker does.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST')) delete env[key];
  }

  const child: ChildProcess = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(HERE, '../..'),
    env,
  });

  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.stdout?.on('data', (d) => { stdout += String(d); });

  let exited = false;
  child.on('exit', () => { exited = true; });

  // Wait for the socket the daemon creates after listen() succeeds.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) break;
    if (exited) {
      throw new Error(`daemon exited before creating its socket.\nstderr:\n${stderr}\nstdout:\n${stdout}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!fs.existsSync(socketPath)) {
    throw new Error(`daemon never created ${socketPath} within 90s.\nstderr:\n${stderr}`);
  }

  const session: Session = {
    id,
    socketPath,
    mountDir,
    stderr: () => stderr + stdout,
    alive: () => !exited,
    async run(command: string, settleMs = 1200) {
      return sendAndCollect(socketPath, command, settleMs);
    },
    async stop() {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 300));
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      for (const ext of ['.json', '.sock', '.log']) {
        try { fs.unlinkSync(path.join(SESSIONS_DIR, id + ext)); } catch { /* fine */ }
      }
      try { fs.rmSync(mountDir, { recursive: true, force: true }); } catch { /* fine */ }
    },
  };
  return session;
}

/**
 * Send one line to the shell and return the output that follows.
 *
 * A carriage return, not a newline: the shell reads keystrokes from a terminal
 * and submits on CR.
 */
export function sendAndCollect(socketPath: string, command: string, settleMs = 1200): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let buffer = '';
    const socket = net.connect(socketPath, () => {
      socket.write(JSON.stringify({ type: 'input', data: command + '\r' }) + '\n');
      setTimeout(() => { socket.end(); resolve(stripAnsi(out)); }, settleMs);
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'output' && typeof msg.data === 'string') out += msg.data;
        } catch { /* not a protocol line */ }
      }
    });
    socket.on('error', reject);
  });
}

/** Pick a free host port, so parallel-ish runs don't collide. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
