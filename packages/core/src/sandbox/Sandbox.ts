import { Kernel } from '../kernel/index.js';
import { Shell } from '../shell/Shell.js';
import {
	createDefaultRegistry,
} from '../commands/registry.js';
import { createPsCommand } from '../commands/system/ps.js';
import { createTopCommand } from '../commands/system/top.js';
import { createKillCommand } from '../commands/system/kill.js';
import { createWatchCommand } from '../commands/system/watch.js';
import { createHelpCommand } from '../commands/system/help.js';
import { createNodeCommand } from '../commands/system/node.js';
import { createCurlCommand } from '../commands/net/curl.js';
import { createTunnelCommandV2 } from '../commands/net/tunnel-v2.js';
import { createBrowserMetroCommand } from '../commands/system/browser-metro.js';
import { createIfconfigCommand } from '../commands/net/ifconfig.js';
import { createRouteCommand } from '../commands/net/route.js';
import { createNetstatCommand } from '../commands/net/netstat.js';
import { createHostCommand } from '../commands/net/host.js';
import { createIPCommand } from '../commands/net/ip.js';
import { createNpmCommand, createNpxCommand } from '../commands/system/npm.js';
import { createLifoPkgCommand, bootLifoPackages } from '../commands/system/lifo.js';
import { createSystemctlCommand } from '../commands/system/systemctl.js';
import type { VFS } from '../kernel/vfs/index.js';
import { NativeFsProvider } from '../kernel/vfs/providers/NativeFsProvider.js';
import type { NativeFsModule } from '../kernel/vfs/providers/NativeFsProvider.js';
import type { ITerminal } from '../terminal/ITerminal.js';
import type { SandboxOptions, SandboxCommands, SandboxFs, SnapshotOptions } from './types.js';
import { SandboxFsImpl } from './SandboxFs.js';
import { SandboxCommandsImpl } from './SandboxCommands.js';
import { HeadlessTerminal } from './HeadlessTerminal.js';
import { dispatchRequest, waitForPort } from '../kernel/network/dispatch.js';
import { connectVmWebSocket } from './vm-websocket.js';
import type { SandboxConnectOptions, VmWebSocket } from './vm-websocket.js';

export interface SandboxFetchInit {
	method?: string;
	headers?: HeadersInit | Record<string, string>;
	body?: string | Uint8Array | ArrayBuffer;
	/** In-VM port, when `input` is a bare path rather than a full URL. */
	port?: number;
	/** Milliseconds to wait for the server (default 120s). */
	timeout?: number;
}

/**
 * Resolve a fetch target to an in-VM port + a server-relative URL.
 *
 * The port has to come from somewhere explicit: there is no ambient "current
 * port" for a sandbox, and silently defaulting to one would send requests to the
 * wrong server. So a bare path requires `{ port }`, and a full URL must be
 * loopback — a request to a real external host is not something this method can
 * honour, and pretending otherwise would be worse than refusing.
 */
function resolveTarget(input: string | URL, portOption?: number): { port: number; url: string } {
	const raw = typeof input === 'string' ? input : input.href;

	if (raw.startsWith('/')) {
		if (portOption == null) {
			throw new Error(`sandbox.fetch: "${raw}" is a path, so it needs a port — pass { port } or use an absolute http://localhost:<port>/… URL`);
		}
		return { port: portOption, url: raw };
	}

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`sandbox.fetch: "${raw}" is not a valid URL`);
	}

	if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
		throw new Error(`sandbox.fetch: only loopback hosts address the sandbox, got "${parsed.hostname}" — use the global fetch for external requests`);
	}

	const port = parsed.port ? Number(parsed.port) : portOption ?? (parsed.protocol === 'https:' ? 443 : 80);
	return { port, url: parsed.pathname + parsed.search };
}

export class Sandbox {
	/** Programmatic command execution */
	readonly commands: SandboxCommands;
	/** Filesystem operations */
	readonly fs: SandboxFs;
	/** Environment variables */
	readonly env: Record<string, string>;

	// Power-user escape hatches
	readonly kernel: Kernel;
	readonly shell: Shell;

	private _destroyed = false;

	private constructor(
		kernel: Kernel,
		shell: Shell,
		commands: SandboxCommands,
		fs: SandboxFs,
		env: Record<string, string>,
	) {
		this.kernel = kernel;
		this.shell = shell;
		this.commands = commands;
		this.fs = fs;
		this.env = env;
	}

	/** Current working directory */
	get cwd(): string {
		return this.shell.getCwd();
	}

	set cwd(path: string) {
		this.shell.setCwd(path);
	}

	/**
	 * Create a new Sandbox instance.
	 * Orchestrates all boot steps: Kernel, VFS, Registry, Shell, config sourcing.
	 */
	static async create(options?: SandboxOptions): Promise<Sandbox> {
		// 1. Create and boot kernel
		const kernel = new Kernel();
		await kernel.boot({ persist: options?.persist ?? false });

		// 2. Create command registry
		const registry = createDefaultRegistry();
		bootLifoPackages(kernel.vfs, registry);

		// 3. Pre-populate files if provided
		if (options?.files) {
			for (const [path, content] of Object.entries(options.files)) {
				ensureParentDirs(kernel.vfs, path);
				kernel.vfs.writeFile(path, content);
			}
		}

		// 4. Set up environment
		const defaultEnv = kernel.getDefaultEnv();
		const env = { ...defaultEnv, ...options?.env };
		if (options?.cwd) {
			env.PWD = options.cwd;
		}

		// 5. Create terminal (headless or visual)
		let shellTerminal: ITerminal;
		let isVisual = false;

		if (typeof options?.terminal === 'string' || (typeof HTMLElement !== 'undefined' && options?.terminal instanceof HTMLElement)) {
			// Visual mode: lazy-load xterm.js from @lifo-sh/ui
			const { Terminal } = await import('@lifo-sh/ui');
			const container = resolveContainer(options.terminal);
			const xtermTerminal = new Terminal(container);
			shellTerminal = xtermTerminal;
			isVisual = true;

			// Display MOTD
			const motd = kernel.vfs.readFileString('/etc/motd');
			xtermTerminal.write(motd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
		} else if (options?.terminal && typeof options.terminal === 'object') {
			// Pre-created ITerminal instance
			shellTerminal = options.terminal as ITerminal;
			isVisual = true;
		} else {
			// Headless mode
			shellTerminal = new HeadlessTerminal();
		}

		// 6. Create shell
		const shell = new Shell(shellTerminal, kernel.vfs, registry, env, kernel.processRegistry);

		// 7. Register factory commands
		const processRegistry = shell.getProcessRegistry();
		registry.register('ps', createPsCommand(processRegistry));
		registry.register('top', createTopCommand(processRegistry));
		registry.register('kill', createKillCommand(processRegistry));
		registry.register('watch', createWatchCommand(registry));
		registry.register('help', createHelpCommand(registry));
		registry.register('node', createNodeCommand(kernel));
		registry.register('curl', createCurlCommand(kernel));
		registry.register('tunnel', createTunnelCommandV2(kernel));
		registry.register('browser-metro', createBrowserMetroCommand(kernel));

		// Register network commands
		registry.register('ifconfig', createIfconfigCommand(kernel));
		registry.register('route', createRouteCommand(kernel));
		registry.register('netstat', createNetstatCommand(kernel));
		registry.register('host', createHostCommand(kernel));
		registry.register('ip', createIPCommand(kernel));

		// Register npm with shell execution support
		const npmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
			const result = await shell.execute(cmd, {
				cwd: cmdCtx.cwd,
				env: cmdCtx.env,
				onStdout: (data: string) => cmdCtx.stdout.write(data),
				onStderr: (data: string) => cmdCtx.stderr.write(data),
			});
			return result.exitCode;
		};
		registry.register('npm', createNpmCommand(registry, npmShellExecute, kernel));
		registry.register('npx', createNpxCommand(registry, npmShellExecute));
		registry.register('lifo', createLifoPkgCommand(registry, npmShellExecute));
		// 7b. Service manager & systemctl
		kernel.initServiceManager(registry, env);
		registry.register('systemctl', createSystemctlCommand(kernel));

		// 8. Source config files
		await shell.sourceFile('/etc/profile');
		await shell.sourceFile(env.HOME + '/.bashrc');

		// 9. Set initial cwd if provided
		if (options?.cwd) {
			shell.setCwd(options.cwd);
		}
		// 9b. Boot enabled services
		await kernel.bootServices();

		// 10. Start shell (for visual mode, enables interactive input)
		if (isVisual) {
			shell.start();
			shellTerminal.focus();
		}

		// 11. Build the Sandbox
		const getCwd = () => shell.getCwd();
		const sandboxFs = new SandboxFsImpl(kernel.vfs, getCwd);
		const sandboxCommands = new SandboxCommandsImpl(shell, registry);

		const sandbox = new Sandbox(kernel, shell, sandboxCommands, sandboxFs, env);

		// 12. Mount native filesystems if specified in options
		if (options?.mounts) {
			for (const mount of options.mounts) {
				sandbox.mountNative(mount.virtualPath, mount.hostPath, {
					readOnly: mount.readOnly,
					fsModule: mount.fsModule,
				});
			}
		}

		return sandbox;
	}

	/**
	 * Mount a native filesystem directory into the virtual filesystem.
	 * Only works in Node.js environments (or when a custom fsModule is provided).
	 *
	 * Once mounted, all VFS operations (and therefore the node-compat fs shim)
	 * on paths under `virtualPath` will be delegated through the VFS mount system
	 * to the NativeFsProvider, which in turn delegates to the real node:fs module.
	 *
	 * @param virtualPath - Path inside the virtual filesystem (e.g. "/mnt/project")
	 * @param hostPath - Host filesystem path to mount (e.g. "/home/user/my-project")
	 * @param options - Optional settings: readOnly, fsModule
	 */
	mountNative(virtualPath: string, hostPath: string, options?: { readOnly?: boolean; fsModule?: NativeFsModule }): void {
		if (this._destroyed) throw new Error('Sandbox is destroyed');

		let fsModule = options?.fsModule;

		if (!fsModule) {
			// Try to get the native fs module. This only works in Node.js environments.
			// We use a dynamic require pattern that works at runtime but avoids
			// static analysis by bundlers.
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const mod = 'node:fs';
				fsModule = (globalThis as unknown as Record<string, Function>).require?.(mod) as NativeFsModule | undefined;
			} catch {
				// globalThis.require may not exist
			}

			if (!fsModule) {
				throw new Error(
					'mountNative requires a Node.js environment or a custom fsModule. ' +
					'Pass { fsModule: require("node:fs") } in a Node.js environment, ' +
					'or provide a compatible NativeFsModule implementation.'
				);
			}
		}

		const provider = new NativeFsProvider(hostPath, fsModule, {
			readOnly: options?.readOnly ?? false,
		});
		this.kernel.vfs.mount(virtualPath, provider);
	}

	/**
	 * Unmount a previously mounted filesystem.
	 *
	 * @param virtualPath - The virtual path that was passed to mountNative()
	 */
	unmountNative(virtualPath: string): void {
		if (this._destroyed) throw new Error('Sandbox is destroyed');
		this.kernel.vfs.unmount(virtualPath);
	}

	/**
	 * Attach a headless sandbox to a DOM element, enabling visual mode.
	 */
	async attach(container: HTMLElement): Promise<void> {
		if (this._destroyed) throw new Error('Sandbox is destroyed');
		const { Terminal } = await import('@lifo-sh/ui');
		const xtermTerminal = new Terminal(container);

		const motd = this.kernel.vfs.readFileString('/etc/motd');
		xtermTerminal.write(motd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
		xtermTerminal.focus();
	}

	/**
	 * Detach from visual mode.
	 */
	detach(): void {
		// v1: no-op placeholder
	}

	/**
	 * Make an HTTP request to a server running INSIDE this sandbox — no service
	 * worker, no port forwarding, no host networking involved.
	 *
	 * ```js
	 * const res = await sandbox.fetch('http://localhost:54321/rest/v1/todos', {
	 *   headers: { apikey: ANON_KEY },
	 * });
	 * const todos = await res.json();
	 * ```
	 *
	 * The URL's port selects the in-VM server, so the host must be loopback
	 * (`localhost` / `127.0.0.1`); pass `{ port }` when you only hold a path.
	 * Note this is a HOST→VM call: it is unrelated to the `fetch` that app code
	 * running inside the VM sees.
	 *
	 * Never throws for transport reasons — an unbound port resolves as a 404
	 * carrying `x-lifo: no-server`, a timeout as a 504, exactly as the service
	 * worker behaves, so host and browser see the same thing for the same box.
	 */
	async fetch(input: string | URL, init: SandboxFetchInit = {}): Promise<Response> {
		if (this._destroyed) throw new Error('Sandbox is destroyed');
		const { port, url } = resolveTarget(input, init.port);

		const headers: Record<string, string> = {};
		new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => { headers[key] = value; });

		const body = init.body == null
			? undefined
			: typeof init.body === 'string'
				? init.body
				: new Uint8Array(init.body as ArrayBuffer);

		// In-VM body parsers (body-parser/express.json's hasBody()) need
		// Content-Length; fetch omits it, so restore it as the SW/nosw shims do.
		if (body != null && headers['content-length'] == null) {
			headers['content-length'] = String(
				typeof body === 'string' ? new TextEncoder().encode(body).length : body.length,
			);
		}

		const res = await dispatchRequest(
			this.kernel.portRegistry,
			port,
			{ method: init.method ?? 'GET', url, headers, body },
			{ timeoutMs: init.timeout },
		);

		// 204/205/304 are null-body statuses — Response throws if given a body.
		const nullBody = res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;
		return new Response(nullBody ? null : (res.bodyBytes as unknown as BodyInit), {
			status: res.statusCode,
			headers: res.headers,
		});
	}

	/**
	 * Open a WebSocket to a server running INSIDE this sandbox — no service
	 * worker, no host networking.
	 *
	 * ```js
	 * const ws = await sandbox.connect(5173, '/hot');   // Vite HMR
	 * ws.onmessage = (e) => console.log(e.data);
	 * ws.send('ping');
	 * ```
	 *
	 * The returned object is WebSocket-*shaped* (`send`, `close`, `readyState`,
	 * `onopen`/`onmessage`/`onclose`/`onerror`, `addEventListener`) but is not a
	 * real `WebSocket` — there is no socket, and no URL a browser could open. The
	 * promise resolves once the in-VM server has completed its handshake, so a
	 * message sent immediately afterwards is not dropped.
	 *
	 * Text frames arrive as strings; binary frames as `Uint8Array` (there is no
	 * `binaryType` to switch, since nothing here is a Blob).
	 *
	 * Rejects if no server on `port` handles upgrades. Use `waitForPort` first if
	 * the server is still starting.
	 */
	async connect(port: number, url = '/', options: SandboxConnectOptions = {}): Promise<VmWebSocket> {
		if (this._destroyed) throw new Error('Sandbox is destroyed');
		return connectVmWebSocket(this.kernel.portRegistry, port, url, options);
	}

	/**
	 * Resolve once a server is listening on `port` inside the sandbox.
	 *
	 * "Listening" is all the port registry knows — it cannot report readiness, so
	 * a server that binds before it can serve will still need a retried request.
	 */
	async waitForPort(port: number, options: { timeout?: number } = {}): Promise<void> {
		if (this._destroyed) throw new Error('Sandbox is destroyed');
		return waitForPort(this.kernel.portRegistry, port, options);
	}

	/**
	 * Export the VFS as a tar.gz snapshot. Pass `{ exclude: ['node_modules'] }`
	 * to skip subtrees (smaller snapshot; restore then needs a reinstall).
	 */
	async exportSnapshot(options?: SnapshotOptions): Promise<Uint8Array> {
		return this.fs.exportSnapshot(options);
	}

	/**
	 * Restore VFS from a tar.gz snapshot.
	 */
	async importSnapshot(data: Uint8Array): Promise<void> {
		return this.fs.importSnapshot(data);
	}

	/**
	 * Destroy the sandbox, releasing all resources.
	 */
	destroy(): void {
		this._destroyed = true;
	}
}

// ─── Helpers ───

function resolveContainer(target: string | HTMLElement): HTMLElement {
	if (typeof target === 'string') {
		const el = document.querySelector(target);
		if (!el) throw new Error(`Sandbox: element not found: ${target}`);
		return el as HTMLElement;
	}
	return target;
}

function ensureParentDirs(vfs: VFS, filePath: string): void {
	const parts = filePath.split('/').filter(Boolean);
	parts.pop(); // remove filename
	let current = '';
	for (const part of parts) {
		current += '/' + part;
		if (!vfs.exists(current)) {
			vfs.mkdir(current, { recursive: true });
		}
	}
}
