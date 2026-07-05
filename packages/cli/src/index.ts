/**
 * index.ts — lifo CLI entry point
 *
 * Commands
 * ────────
 *   lifo                          Interactive shell (ephemeral, exits with terminal)
 *   lifo --mount <path>           Interactive shell with host directory mounted at /mnt/host
 *
 *   lifo new [--mount <path>]     Boot a new VM daemon and immediately attach to it.
 *                                 Ctrl+D or `exit` detaches; VM keeps running.
 *
 *   lifo --detach [--mount <path>] Boot a VM daemon in the background, print its ID,
 *                                  return to the host shell immediately.
 *
 *   lifo list                     List all running (and dead) VM sessions.
 *   lifo attach <id>              Wire this terminal to an existing VM.
 *   lifo stop <id>                Send SIGTERM to the daemon and remove session files.
 *
 *   lifo login / logout / whoami  Auth helpers (see auth.ts).
 *
 * Internal flag (not user-facing):
 *   lifo --daemon --id <id> --mount <path>
 *                                 Runs as the background daemon process.
 *                                 Spawned by startDaemon(); should not be called directly.
 *
 * Architecture overview
 * ─────────────────────
 *   Host terminal
 *     └─ lifo new / lifo attach <id>   (attach.ts: attachToSession)
 *          └─ Unix socket ~/.lifo/sessions/<id>.sock
 *               └─ Daemon process (index.ts: runDaemon)
 *                    ├─ DaemonTerminal  (multiplexes socket clients ↔ Shell)
 *                    ├─ Kernel + VFS
 *                    └─ Shell
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	Kernel,
	Shell,
	NativeFsProvider,
	createDefaultRegistry,
	createLifoPkgCommand,
	createNpmCommand,
	createPsCommand,
	createTopCommand,
	createKillCommand,
	createWatchCommand,
	createHelpCommand,
	createNodeCommand,
	createCurlCommand,
	rehydrateGlobalPackages,
} from '@lifo-sh/core';
import { NodeTerminal } from './NodeTerminal.js';
import { DaemonTerminal } from './DaemonTerminal.js';
import { TOKEN_PATH, readToken, handleLogin, handleLogout, handleWhoami } from './auth.js';
import { SESSIONS_DIR, writeSession, deleteSession, readSession, listSessions } from './session.js';
import { startDaemon } from './daemon.js';
import { attachToSession, attachViaTcp } from './attach.js';
import {
	SNAPSHOTS_DIR,
	requestSnapshot,
	writeSnapshotZip,
	readSnapshotZip,
	listSnapshots,
} from './snapshot.js';
import { handleTunnel, createHostTunnelCommand } from './tunnel.js';
import { serialize, deserialize } from '@lifo-sh/core';

// ─── CLI argument parsing ──────────────────────────────────────────────────────

/**
 * All recognised user-facing subcommands. Used by getEffectiveArgs() to find
 * where the real user input starts when pnpm dev mode injects extra args.
 */
const SUBCOMMANDS = new Set(['login', 'logout', 'whoami', 'list', 'attach', 'stop', 'new', 'snapshot', 'tunnel']);

/**
 * Returns the user-facing args, stripping any leading positional args that
 * were injected by the pnpm dev script.
 *
 * Problem: `pnpm dev:cli lifo-sh list` expands to `tsx src/index.ts lifo-sh list`
 * so process.argv[2] is "lifo-sh" (the package name), not the subcommand.
 *
 * Fix: scan forward from argv[2] and skip any args that are neither a known
 * subcommand nor a flag (starts with `-`). The first recognised token onwards
 * is what the user actually typed.
 *
 * In production (`node dist/index.js list`) there are no injected args so
 * the scan finds "list" at position 0 immediately and nothing is stripped.
 */
function getEffectiveArgs(): string[] {
	const args = process.argv.slice(2);
	const start = args.findIndex(a => a.startsWith('-') || SUBCOMMANDS.has(a));
	return start >= 0 ? args.slice(start) : args;
}

interface CliOptions {
	mount?: string;
	detach?: boolean;
	/** TCP port for remote attach. Daemon listens on both Unix socket AND this port. */
	port?: number;
	/** Internal flag — marks the process as a background daemon. Not user-facing. */
	daemon?: boolean;
	/** Internal flag — the session ID passed to the daemon by startDaemon(). */
	id?: string;
	/** Internal flag — path to a snapshot JSON file to restore on daemon boot. */
	snapshot?: string;
}

function parseArgs(args: string[]): CliOptions {
	const opts: CliOptions = {};
	for (let i = 0; i < args.length; i++) {
		if ((args[i] === '--mount' || args[i] === '-m') && args[i + 1]) {
			opts.mount = path.resolve(args[i + 1]!);
			i++;
		} else if (args[i] === '--detach' || args[i] === '-d') {
			opts.detach = true;
		} else if (args[i] === '--port' && args[i + 1]) {
			const p = parseInt(args[i + 1]!, 10);
			if (isNaN(p) || p < 1 || p > 65535) {
				console.error(`Error: --port must be a number between 1 and 65535`);
				process.exit(1);
			}
			opts.port = p;
			i++;
		} else if (args[i] === '--daemon') {
			opts.daemon = true;
		} else if (args[i] === '--id' && args[i + 1]) {
			opts.id = args[i + 1]!;
			i++;
		} else if (args[i] === '--snapshot' && args[i + 1]) {
			opts.snapshot = args[i + 1]!;
			i++;
		}
	}
	return opts;
}

// ─── Subcommand: list ─────────────────────────────────────────────────────────

/** Prints a table of all sessions from ~/.lifo/sessions/, with liveness check. */
function handleList(): void {
	const sessions = listSessions();
	if (sessions.length === 0) {
		console.log('No running VMs.');
		return;
	}
	const now = Date.now();
	const showPort = sessions.some(s => s.port !== undefined);
	const header = showPort
		? 'ID       UPTIME   PORT   MOUNT                              STATUS'
		: 'ID       UPTIME   MOUNT                              STATUS';
	console.log(header);
	for (const s of sessions) {
		const uptimeMs = now - new Date(s.startedAt).getTime();
		const uptimeSec = Math.floor(uptimeMs / 1000);
		const uptime =
			uptimeSec < 60
				? `${uptimeSec}s`
				: uptimeSec < 3600
					? `${Math.floor(uptimeSec / 60)}m`
					: `${Math.floor(uptimeSec / 3600)}h`;
		const mount = s.mountPath.padEnd(34).slice(0, 34);
		const status = s.alive ? 'running' : 'dead';
		if (showPort) {
			const port = s.port !== undefined ? String(s.port).padEnd(6) : '      ';
			console.log(`${s.id.padEnd(8)} ${uptime.padEnd(8)} ${port} ${mount} ${status}`);
		} else {
			console.log(`${s.id.padEnd(8)} ${uptime.padEnd(8)} ${mount} ${status}`);
		}
	}
}

// ─── Subcommand: stop ─────────────────────────────────────────────────────────

/**
 * Gracefully shuts down a VM by sending SIGTERM to its daemon process,
 * then removes the session files. The daemon's SIGTERM handler closes the
 * socket server and calls process.exit(0).
 */
function handleStop(id: string): void {
	const session = readSession(id);
	if (!session) {
		console.error(`No session found with id: ${id}`);
		process.exit(1);
	}
	try {
		process.kill(session.pid, 'SIGTERM');
	} catch {
		// Process may have already died (crash, manual kill, etc.) — that's fine,
		// we still want to clean up the stale session files below.
	}
	deleteSession(id);
	console.log(`Stopped VM ${id}`);
}

// ─── Daemon mode (internal) ───────────────────────────────────────────────────

/**
 * Runs the lifo kernel + shell as a headless background daemon.
 *
 * This function is only ever entered when the process was spawned by
 * startDaemon() with the hidden `--daemon` flag. It should never be called
 * directly by users.
 *
 * Startup sequence:
 *   1. Boot kernel and mount the host directory at /mnt/host.
 *   2. Create a DaemonTerminal (socket-backed ITerminal).
 *   3. Build and start the Shell.
 *   4. Start a Unix socket server and write the session file so the parent
 *      process (and future `lifo attach` calls) can find us.
 *
 * Shutdown:
 *   SIGTERM / SIGHUP → close socket server + delete session files + exit.
 *   `exit` typed in the shell → disconnects all clients, VM keeps running.
 */
async function runDaemon(id: string, mountPath: string, port?: number, snapshotPath?: string): Promise<void> {
	const socketPath = path.join(SESSIONS_DIR, `${id}.sock`);

	fs.mkdirSync(SESSIONS_DIR, { recursive: true });

	// Remove a stale socket left by a previously crashed daemon with this ID.
	try { fs.unlinkSync(socketPath); } catch { /* ok if it doesn't exist */ }

	const daemonTerminal = new DaemonTerminal();

	// ── Kernel ────────────────────────────────────────────────────────────────
	const kernel = new Kernel();
	await kernel.boot({ persist: false }); // in-memory VFS; state lives in this process

	// Read snapshot file ONCE up-front, then immediately delete it.
	// The daemon only needs it during startup — it should not linger on disk.
	interface SnapPayload { vfs: any; cwd?: string; env?: Record<string, string> }
	let snap: SnapPayload | null = null;
	if (snapshotPath) {
		try {
			snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as SnapPayload;
		} catch (err: any) {
			process.stderr.write(`Warning: failed to read snapshot: ${err.message}\n`);
		} finally {
			try { fs.unlinkSync(snapshotPath); } catch { /* already gone — that's fine */ }
		}
	}

	// Restore VFS from snapshot before mounting the host directory.
	if (snap) {
		try {
			kernel.vfs.loadFromSerialized(deserialize(snap.vfs));
		} catch (err: any) {
			process.stderr.write(`Warning: failed to restore snapshot VFS: ${err.message}\n`);
		}
	}

	const MOUNT_PATH = '/mnt/host';
	kernel.vfs.mkdir('/mnt', { recursive: true });
	const nativeProvider = new NativeFsProvider(mountPath, fs);
	kernel.vfs.mount(MOUNT_PATH, nativeProvider);

	// ── Shell ─────────────────────────────────────────────────────────────────
	const registry = createDefaultRegistry();
	rehydrateGlobalPackages(kernel.vfs, registry);

	const env = kernel.getDefaultEnv();
	env.PWD = MOUNT_PATH;          // start the shell inside the mounted directory
	env.LIFO_HOST_DIR = mountPath; // expose host path for scripts that need it

	// Overlay saved env vars — reuse already-parsed snap, no second file read.
	if (snap?.env && typeof snap.env === 'object') {
		for (const [k, v] of Object.entries(snap.env)) {
			if (k !== 'LIFO_HOST_DIR' && k !== 'LIFO_AUTH_TOKEN' && k !== 'LIFO_TOKEN_PATH') {
				env[k] = v;
			}
		}
	}

	const token = readToken();
	if (token) env.LIFO_AUTH_TOKEN = token;
	env.LIFO_TOKEN_PATH = TOKEN_PATH;

	const shell = new Shell(daemonTerminal, kernel.vfs, registry, env);

	const jobTable = shell.getJobTable();
	registry.register('ps', createPsCommand(jobTable));
	registry.register('top', createTopCommand(jobTable));
	registry.register('kill', createKillCommand(jobTable));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));
	registry.register('node', createNodeCommand(kernel));
	registry.register('curl', createCurlCommand(kernel));
	registry.register('tunnel', createHostTunnelCommand());

	const npmShellExecute = async (
		cmd: string,
		cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } },
	) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, npmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, npmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');

	// Restore CWD from snapshot — only if the path actually exists in the VFS.
	const snapshotCwd = snap?.cwd;
	if (snapshotCwd && kernel.vfs.exists(snapshotCwd)) {
		shell.setCwd(snapshotCwd);
	}

	// Override `exit` to detach all clients instead of killing the daemon.
	// This matches Docker's behaviour: exiting an attached session drops you
	// back to the host shell but the container (VM) stays alive.
	// To actually kill the VM, use `lifo stop <id>`.
	(shell as any).builtins.set('exit', async () => {
		daemonTerminal.disconnectAllClients();
		return 0;
	});

	// Register snapshot handler — responds to one-shot { type: "snapshot" } requests.
	// Uses setImmediate to yield the event loop before the CPU-heavy serialize()
	// so in-flight shell output isn't delayed for other attached clients.
	daemonTerminal.onSnapshot((socket) => {
		setImmediate(() => {
			const data = {
				type: 'snapshot-data',
				vfs: serialize(kernel.vfs.getRoot()),
				cwd: shell.getCwd(),
				env: shell.getEnv(),
				mountPath,  // save original mount path so restore can reuse it
			};
			socket.write(JSON.stringify(data) + '\n');
			socket.end();
		});
	});

	// ── Socket server ─────────────────────────────────────────────────────────
	const motd = kernel.vfs.readFileString('/etc/motd');
	const motdText = motd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

	/** Shared client handler — identical logic for Unix and TCP clients. */
	function handleClient(socket: net.Socket) {
		// Greet each newly attached client with the MOTD and mount info.
		const mountInfo = `\x1b[2mMounted: ${mountPath} -> ${MOUNT_PATH}\x1b[0m\r\n`;
		const welcome = JSON.stringify({ type: 'output', data: motdText + mountInfo }) + '\n';
		socket.write(welcome);
		daemonTerminal.addClient(socket);
	}

	const server = net.createServer(handleClient);

	// Start listening BEFORE writing the session file so the parent process
	// (polling for the session JSON) doesn't see a partially-ready daemon.
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	// Restrict the socket to the owner only — other users on the same system
	// should not be able to attach to this VM.
	try { fs.chmodSync(socketPath, 0o600); } catch { /* non-fatal on odd filesystems */ }

	// Optionally also bind a TCP server so remote clients can attach directly
	// without needing access to the Unix socket file.
	// WARNING: unauthenticated — only use on trusted networks.
	let tcpServer: net.Server | undefined;
	if (port !== undefined) {
		tcpServer = net.createServer(handleClient);
		// Try IPv6 wildcard first (dual-stack on most systems). Fall back to IPv4
		// wildcard if the host has IPv6 disabled.
		try {
			await new Promise<void>((resolve, reject) => {
				tcpServer!.once('error', reject);
				tcpServer!.listen(port, '::', resolve);
			});
		} catch {
			await new Promise<void>((resolve, reject) => {
				tcpServer!.once('error', reject);
				tcpServer!.listen(port, '0.0.0.0', resolve);
			});
		}
	}

	// Now that the socket is ready, register ourselves in the session registry.
	writeSession({ id, pid: process.pid, socketPath, mountPath, startedAt: new Date().toISOString(), port });

	shell.start();

	// ── Shutdown handler ──────────────────────────────────────────────────────
	function shutdown() {
		server.close();           // stop accepting new connections on Unix socket
		tcpServer?.close();       // stop accepting new connections on TCP (if any)
		deleteSession(id);        // clean up ~/.lifo/sessions/<id>.{json,sock}
		process.exit(0);
	}

	process.on('SIGTERM', shutdown); // sent by `lifo stop <id>`
	process.on('SIGHUP', shutdown); // sent when parent terminal closes
}

// ─── Interactive mode (default) ───────────────────────────────────────────────

/**
 * The original lifo behaviour: boot a kernel+shell attached directly to the
 * current terminal. The session is ephemeral — it dies when the terminal closes.
 * No background daemon, no socket, no session file.
 */
async function runInteractive(opts: CliOptions): Promise<void> {
	const terminal = new NodeTerminal();

	let hostDir: string;
	let isTempSession = false;

	if (opts.mount) {
		if (!fs.existsSync(opts.mount)) {
			console.error(`Error: mount path does not exist: ${opts.mount}`);
			process.exit(1);
		}
		if (!fs.statSync(opts.mount).isDirectory()) {
			console.error(`Error: mount path is not a directory: ${opts.mount}`);
			process.exit(1);
		}
		hostDir = opts.mount;
	} else {
		// No mount path given — create a throwaway temp directory.
		hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-'));
		isTempSession = true;
	}

	const kernel = new Kernel();
	await kernel.boot({ persist: false });

	const MOUNT_PATH = '/mnt/host';
	kernel.vfs.mkdir('/mnt', { recursive: true });
	const nativeProvider = new NativeFsProvider(hostDir, fs);
	kernel.vfs.mount(MOUNT_PATH, nativeProvider);

	const registry = createDefaultRegistry();
	rehydrateGlobalPackages(kernel.vfs, registry);

	const env = kernel.getDefaultEnv();
	env.PWD = MOUNT_PATH;
	env.LIFO_HOST_DIR = hostDir;

	const token = readToken();
	if (token) env.LIFO_AUTH_TOKEN = token;
	env.LIFO_TOKEN_PATH = TOKEN_PATH;

	const shell = new Shell(terminal, kernel.vfs, registry, env);

	const jobTable = shell.getJobTable();
	registry.register('ps', createPsCommand(jobTable));
	registry.register('top', createTopCommand(jobTable));
	registry.register('kill', createKillCommand(jobTable));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));
	registry.register('node', createNodeCommand(kernel));
	registry.register('curl', createCurlCommand(kernel));
	registry.register('tunnel', createHostTunnelCommand());

	const npmShellExecute = async (
		cmd: string,
		cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } },
	) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, npmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, npmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');

	// In interactive mode `exit` should terminate the process entirely.
	(shell as any).builtins.set('exit', async () => {
		cleanup();
		return 0;
	});

	const motd = kernel.vfs.readFileString('/etc/motd');
	terminal.write(motd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));

	// 8b. Boot enabled services
	await kernel.bootServices();

	// 9. Override exit
	(shell as any).builtins.set(
		'exit',
		async () => {
			cleanup();
			return 0;
		},
	);

	function cleanup() {
		terminal.destroy();
		if (isTempSession) {
			// Clean up the throwaway temp directory we created above.
			try { fs.rmSync(hostDir, { recursive: true, force: true }); } catch { /* best effort */ }
		}
		process.exit(0);
	}

	process.on('SIGTERM', cleanup);
	process.on('SIGHUP', cleanup);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	// Strip any pnpm-injected package-name arg so dev and prod CLI behave the same.
	const args = getEffectiveArgs();
	const cmd = args[0];

	// ── Auth commands ──────────────────────────────────────────────────────────
	if (cmd === 'login') { await handleLogin(); return; }
	if (cmd === 'logout') { handleLogout(); return; }
	if (cmd === 'whoami') { await handleWhoami(); return; }

	// ── VM lifecycle commands ──────────────────────────────────────────────────
	if (cmd === 'list') { handleList(); return; }

	if (cmd === 'attach') {
		const target = args[1];
		if (!target) {
			console.error('Usage: lifo attach <id>  OR  lifo attach <host>:<port>');
			process.exit(1);
		}
		// Detect <host>:<port> pattern (e.g. "localhost:7777", "192.168.1.100:7777").
		// A bare session ID is a short hex string like "a1b2c3" — it won't contain ":".
		const tcpMatch = target.match(/^(.+):(\d+)$/);
		if (tcpMatch) {
			const host = tcpMatch[1]!;
			const port = parseInt(tcpMatch[2]!, 10);
			await attachViaTcp(host, port);
		} else {
			await attachToSession(target);
		}
		return;
	}

	if (cmd === 'stop') {
		const id = args[1];
		if (!id) { console.error('Usage: lifo stop <id>'); process.exit(1); }
		handleStop(id);
		return;
	}

	if (cmd === 'tunnel') {
		const token = readToken();
		if (!token) {
			console.error('Not logged in. Run `npx lifo-sh login` first.');
			process.exit(1);
		}
		const portArg = args[1];
		const tunnelPort = portArg ? parseInt(portArg, 10) : NaN;
		if (!portArg || isNaN(tunnelPort) || tunnelPort < 1 || tunnelPort > 65535) {
			console.error('Usage: npx lifo-sh tunnel <port>');
			console.error('Example: npx lifo-sh tunnel 5173');
			process.exit(1);
		}
		await handleTunnel(tunnelPort, token);
		return;
	}

	if (cmd === 'snapshot') {
		const sub = args[1];

		if (sub === 'list') {
			const snaps = listSnapshots();
			if (snaps.length === 0) {
				console.log('No snapshots found. Save one with: lifo snapshot save <id>');
			} else {
				console.log('Snapshots in ~/.lifo/snapshots/:');
				for (const s of snaps) console.log(' ', s);
			}
			return;
		}

		if (sub === 'save') {
			const id = args[2];
			if (!id) { console.error('Usage: lifo snapshot save <id> [--output <file.zip>]'); process.exit(1); }

			// Parse --output from remaining args
			let outputPath: string | undefined;
			for (let i = 3; i < args.length; i++) {
				if ((args[i] === '--output' || args[i] === '-o') && args[i + 1]) {
					outputPath = path.resolve(args[i + 1]!);
					break;
				}
			}
			if (!outputPath) {
				fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
				outputPath = path.join(SNAPSHOTS_DIR, `${id}-${Date.now()}.zip`);
			}

			const session = readSession(id);
			if (!session) { console.error(`No session found with id: ${id}`); process.exit(1); }

			console.log(`Requesting snapshot from VM ${id}...`);
			try {
				const data = await requestSnapshot(session.socketPath);
				writeSnapshotZip(data, outputPath);
				console.log(`Snapshot saved to ${outputPath}`);
			} catch (err: any) {
				console.error(`Failed to save snapshot: ${err.message}`);
				process.exit(1);
			}
			return;
		}

		if (sub === 'restore') {
			const zipPath = args[2] ? path.resolve(args[2]) : undefined;
			if (!zipPath) { console.error('Usage: lifo snapshot restore <file.zip> [--mount <path>]'); process.exit(1); }
			if (!fs.existsSync(zipPath)) { console.error(`File not found: ${zipPath}`); process.exit(1); }

			// Parse --mount from remaining args
			let mountPath: string | undefined;
			for (let i = 3; i < args.length; i++) {
				if ((args[i] === '--mount' || args[i] === '-m') && args[i + 1]) {
					mountPath = path.resolve(args[i + 1]!);
					break;
				}
			}

			let data: ReturnType<typeof readSnapshotZip>;
			try {
				data = readSnapshotZip(zipPath);
			} catch (err: any) {
				console.error(`Failed to read snapshot: ${err.message}`);
				process.exit(1);
			}

			// Determine mount path: explicit flag > saved path (if it still exists) > new temp dir
			if (!mountPath) {
				if (data.mountPath && fs.existsSync(data.mountPath) && fs.statSync(data.mountPath).isDirectory()) {
					mountPath = data.mountPath;
					console.log(`Using original mount path: ${mountPath}`);
				} else {
					mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-'));
				}
			}

			// Write snapshot data to a temp file for the daemon process to read on boot.
			const tmpSnap = path.join(os.tmpdir(), `lifo-snap-${Date.now()}.json`);
			fs.writeFileSync(tmpSnap, JSON.stringify({ vfs: data.vfs, cwd: data.cwd, env: data.env }), 'utf-8');

			try {
				const id = await startDaemon(mountPath, undefined, tmpSnap);
				// Daemon has fully booted and read the file by the time startDaemon() resolves.
				// Safe to delete the temp file now.
				try { fs.unlinkSync(tmpSnap); } catch { /* already deleted by daemon */ }
				console.log(`Restored VM ${id} from ${zipPath}`);
				await attachToSession(id);
			} catch (err: any) {
				console.error(`Failed to restore VM: ${err.message}`);
				try { fs.unlinkSync(tmpSnap); } catch { /* ok */ }
				process.exit(1);
			}
			return;
		}

		console.error('Usage: lifo snapshot <save|restore|list>');
		process.exit(1);
	}

	if (cmd === 'new') {
		// Boot a VM daemon and immediately attach to it in one step.
		// Equivalent to: lifo --detach && lifo attach <id>
		// Supports: lifo new [--mount <path>] [--port <n>]
		const newOpts = parseArgs(args.slice(1));
		let mountPath: string;
		if (newOpts.mount) {
			const resolved = newOpts.mount; // already path.resolve'd by parseArgs
			if (!fs.existsSync(resolved)) {
				console.error(`Error: mount path does not exist: ${resolved}`);
				process.exit(1);
			}
			if (!fs.statSync(resolved).isDirectory()) {
				console.error(`Error: mount path is not a directory: ${resolved}`);
				process.exit(1);
			}
			mountPath = resolved;
		} else {
			mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-'));
		}
		try {
			const id = await startDaemon(mountPath, newOpts.port);
			if (newOpts.port !== undefined) {
				console.log(`Started VM ${id} (TCP port: ${newOpts.port})`);
			} else {
				console.log(`Started VM ${id}`);
			}
			await attachToSession(id);
		} catch (err: any) {
			console.error(`Failed to start VM: ${err.message}`);
			process.exit(1);
		}
		return;
	}

	const opts = parseArgs(args);

	// ── Internal: daemon entry point ───────────────────────────────────────────
	// This branch is only reached when startDaemon() spawns this process with
	// --daemon. The flag is intentionally undocumented in help text.
	if (opts.daemon) {
		if (!opts.id) { console.error('--daemon requires --id'); process.exit(1); }
		if (!opts.mount) { console.error('--daemon requires --mount'); process.exit(1); }
		await runDaemon(opts.id, opts.mount, opts.port, opts.snapshot);
		return;
	}

	// ── --detach: boot VM in background, return immediately ───────────────────
	if (opts.detach) {
		let mountPath: string;
		let isTempMount = false;

		if (opts.mount) {
			if (!fs.existsSync(opts.mount)) {
				console.error(`Error: mount path does not exist: ${opts.mount}`);
				process.exit(1);
			}
			if (!fs.statSync(opts.mount).isDirectory()) {
				console.error(`Error: mount path is not a directory: ${opts.mount}`);
				process.exit(1);
			}
			mountPath = opts.mount;
		} else {
			mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-'));
			isTempMount = true;
		}

		try {
			const id = await startDaemon(mountPath, opts.port);
			const portSuffix = opts.port !== undefined ? `, TCP port: ${opts.port}` : '';
			if (isTempMount) {
				console.log(`Started VM ${id} (temp mount: ${mountPath}${portSuffix})`);
			} else {
				console.log(`Started VM ${id} (mounted: ${mountPath}${portSuffix})`);
			}
		} catch (err: any) {
			console.error(`Failed to start daemon: ${err.message}`);
			process.exit(1);
		}
		return;
	}

	// ── Default: ephemeral interactive shell ───────────────────────────────────
	await runInteractive(opts);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
