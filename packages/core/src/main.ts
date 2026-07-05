import { Kernel } from './kernel/index.js';
import { Terminal } from './terminal/Terminal.js';
import { Shell } from './shell/Shell.js';
import { createDefaultRegistry } from './commands/registry.js';
import { createPsCommand } from './commands/system/ps.js';
import { createTopCommand } from './commands/system/top.js';
import { createKillCommand } from './commands/system/kill.js';
import { createWatchCommand } from './commands/system/watch.js';
import { createHelpCommand } from './commands/system/help.js';
import { createNpmCommand, createNpxCommand } from './commands/system/npm.js';
import { createLifoPkgCommand, bootLifoPackages } from './commands/system/lifo.js';
import { createSystemctlCommand } from './commands/system/systemctl.js';

async function boot(): Promise<void> {
	// 1. Kernel & filesystem (async -- loads persisted data)
	const kernel = new Kernel();
	await kernel.boot();

	// 2. Terminal
	const container = document.getElementById('terminal');
	if (!container) throw new Error('Missing #terminal element');
	const terminal = new Terminal(container);

	// 3. Command registry
	const registry = createDefaultRegistry();

	// 3b. Boot lifo packages (dev links + installed lifo-pkg-* upgrades)
	bootLifoPackages(kernel.vfs, registry);

	// 4. Display MOTD
	const motd = kernel.vfs.readFileString('/etc/motd');
	// Convert \n to \r\n for xterm
	terminal.write(motd.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));

	// 5. Shell
	const env = kernel.getDefaultEnv();
	const shell = new Shell(terminal, kernel.vfs, registry, env, kernel.processRegistry);

	// 5b. Register factory commands that need shell/registry access
	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));

	// 5c. Register npm with shell execution support
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

	// 5d. Service manager & systemctl
	kernel.initServiceManager(registry, env);
	registry.register('systemctl', createSystemctlCommand(kernel));

	// 6. Source config files before showing prompt
	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');

	// 6b. Boot enabled services
	await kernel.bootServices();

	// 7. Start shell & focus
	shell.start();
	terminal.focus();
}

boot();
