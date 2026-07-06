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
import type { SandboxOptions, SandboxCommands, SandboxFs } from './types.js';
import { SandboxFsImpl } from './SandboxFs.js';
import { SandboxCommandsImpl } from './SandboxCommands.js';
import { HeadlessTerminal } from './HeadlessTerminal.js';

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
	 * Export the entire VFS as a tar.gz snapshot.
	 */
	async exportSnapshot(): Promise<Uint8Array> {
		return this.fs.exportSnapshot();
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
