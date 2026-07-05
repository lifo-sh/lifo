import { VFS } from './vfs/index.js';
import { ProcProvider } from './vfs/providers/ProcProvider.js';
import { DevProvider } from './vfs/providers/DevProvider.js';
import { PersistenceManager } from './persistence/PersistenceManager.js';
import { IndexedDBPersistenceBackend } from './persistence/backends.js';
import type { PersistenceBackend } from './persistence/backends.js';
import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { NetworkStack } from './network/NetworkStack.js';
import { PortBridge } from './network/PortBridge.js';
import { installSamples } from './samples.js';
import { ServiceManager } from './ServiceManager.js';
import type { CommandRegistry } from '../commands/registry.js';

const MOTD = `\x1b[1;36m
 _     _  __
| |   (_)/ _| ___
| |   | | |_ / _ \\
| |___| |  _| (_) |
|_____|_|_|  \\___/
\x1b[0m
\x1b[2mA Linux-like OS running natively in your browser.\x1b[0m
\x1b[2mType 'help' or try: ls, cd, cat, mkdir, touch\x1b[0m
\x1b[2mExplore examples: ls ~/examples/scripts\x1b[0m
`;

const DEFAULT_PROFILE = `export PATH=/usr/bin:/bin
export EDITOR=nano
`;

const DEFAULT_LIFORC = `# ~/.liforc - Lifo shell configuration
# This file is sourced on shell startup. Edit it to customize your shell.
# Changes take effect on next shell start (refresh the page).

# ─── Aliases ───
alias ll='ls -la'
alias la='ls -a'
alias l='ls -1'
alias ..='cd ..'
alias ...='cd ../..'
alias cls='clear'
alias h='history'
alias q='exit'
alias md='mkdir -p'
alias rd='rmdir'

# ─── Environment ───
export EDITOR=nano
export PAGER=less
`;

const DEFAULT_HOSTS = `127.0.0.1       localhost
::1             localhost ip6-localhost ip6-loopback
`;

export interface VirtualRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
}

export interface VirtualResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
}

export type VirtualRequestHandler = (req: VirtualRequest, res: VirtualResponse) => void;

export class Kernel {
	vfs: VFS;
	portRegistry: Map<number, VirtualRequestHandler> = new Map();
	portBridge: PortBridge;
	processRegistry: ProcessRegistry;
	networkStack: NetworkStack;
	serviceManager: ServiceManager | null = null;
	private persistence: PersistenceManager;

	constructor(backend?: PersistenceBackend) {
		this.vfs = new VFS();
		this.processRegistry = new ProcessRegistry();
		this.networkStack = new NetworkStack();
		this.portBridge = new PortBridge(this.portRegistry);
		this.persistence = new PersistenceManager(
			backend ?? new IndexedDBPersistenceBackend(),
		);
	}

	async boot(options?: { persist?: boolean }): Promise<void> {
		const persist = options?.persist ?? true;

		if (persist) {
			// 1. Load persisted filesystem
			await this.persistence.open();
			const saved = await this.persistence.load();
			if (saved) {
				this.vfs.loadFromSerialized(saved);
			}
		}

		// 2. Initialize standard dirs (idempotent)
		this.initFilesystem();

		// 3. Register virtual providers
		this.vfs.registerProvider('/proc', new ProcProvider());
		this.vfs.registerProvider('/dev', new DevProvider());

		if (persist) {
			// 4. Hook persistence via watch events
			this.vfs.watch(() => {
				this.persistence.scheduleSave(this.vfs.getRoot());
			});
		}
	}

	initFilesystem(): void {
		const dirs = [
			'/bin',
			'/etc',
			'/home',
			'/home/user',
			'/tmp',
			'/var',
			'/var/log',
			'/usr',
			'/usr/bin',
			'/usr/share',
			'/usr/share/pkg',
			'/usr/share/pkg/node_modules',
			'/etc/systemd/system',
			'/etc/systemd/system/multi-user.target.wants',
		];

		for (const dir of dirs) {
			try {
				this.vfs.mkdir(dir, { recursive: true });
			} catch {
				// Directory already exists -- ignore
			}
		}

		// Write system files (always overwrite MOTD/hostname)
		this.vfs.writeFile('/etc/motd', MOTD);
		this.vfs.writeFile('/etc/hostname', 'lifo\n');

		// Write default config files only if they don't exist
		if (!this.vfs.exists('/etc/profile')) {
			this.vfs.writeFile('/etc/profile', DEFAULT_PROFILE);
		}
		// Migrate old .bashrc to .liforc
		if (this.vfs.exists('/home/user/.bashrc') && !this.vfs.exists('/home/user/.liforc')) {
			// Preserve user's existing .bashrc content by renaming it
			try {
				const existing = this.vfs.readFileString('/home/user/.bashrc');
				this.vfs.writeFile('/home/user/.liforc', existing);
			} catch { /* ignore */ }
		}
		if (!this.vfs.exists('/home/user/.liforc')) {
			this.vfs.writeFile('/home/user/.liforc', DEFAULT_LIFORC);
		}
		if (!this.vfs.exists('/etc/hosts')) {
			this.vfs.writeFile('/etc/hosts', DEFAULT_HOSTS);
		}

		// Load hosts file into DNS resolver
		try {
			const hostsContent = this.vfs.readFileString('/etc/hosts');
			this.networkStack.getDNS().loadHostsFile(hostsContent);
		} catch {
			// Ignore if hosts file doesn't exist
		}

		// Install example files
		installSamples(this.vfs);
	}

	initServiceManager(registry: CommandRegistry, defaultEnv: Record<string, string>): void {
		this.serviceManager = new ServiceManager(this.vfs, registry, defaultEnv);
	}

	async bootServices(): Promise<void> {
		if (this.serviceManager) {
			await this.serviceManager.bootEnabledServices();
		}
	}

	getDefaultEnv(): Record<string, string> {
		return {
			HOME: '/home/user',
			USER: 'user',
			HOSTNAME: 'lifo',
			SHELL: '/bin/sh',
			PATH: '/usr/bin:/bin',
			TERM: 'xterm-256color',
			PWD: '/home/user',
		};
	}
}
