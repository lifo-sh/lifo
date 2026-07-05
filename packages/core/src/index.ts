// Sandbox (high-level API)
export { Sandbox } from './sandbox/index.js';
export type {
	SandboxOptions,
	RunOptions,
	CommandResult,
	SandboxCommands,
	SandboxFs,
} from './sandbox/index.js';

// Kernel
export { Kernel } from './kernel/index.js';
export type { VirtualRequest, VirtualResponse, VirtualRequestHandler } from './kernel/index.js';

// Network Stack
export { NetworkStack } from './kernel/network/index.js';
export type {
	IPAddress,
	SocketType,
	SocketAddress,
	NetworkInterface as INetworkInterface,
	RouteEntry,
	NetworkTunnel,
	TunnelType,
} from './kernel/network/index.js';

// Tunnels
export { VETHPair } from './kernel/network/tunnel/VETHPair.js';
export { WebSocketTunnel } from './kernel/network/tunnel/WebSocketTunnel.js';

// Bridge
export { Bridge } from './kernel/network/Bridge.js';

// VFS
export { VFS, VFSError, ErrorCode } from './kernel/vfs/index.js';
export { getMimeType, getFileCategory, isBinaryMime } from './kernel/vfs/index.js';
export { NativeFsProvider } from './kernel/vfs/index.js';
export type {
	INode,
	Stat,
	Dirent,
	FileType,
	ErrorCodeType,
	VirtualProvider,
	MountProvider,
	NativeFsModule,
	VFSWatchEvent,
	VFSWatchListener,
	VFSEventType,
} from './kernel/vfs/index.js';

// Blob storage & content store
export { MemoryBlobStore, IndexedDBBlobStore, hashBytes } from './kernel/storage/index.js';
export { ContentStore, CHUNK_THRESHOLD, CHUNK_SIZE } from './kernel/storage/index.js';
export type { BlobStore } from './kernel/storage/index.js';

// Persistence
export { PersistenceManager } from './kernel/persistence/index.js';
export { IndexedDBPersistenceBackend, MemoryPersistenceBackend } from './kernel/persistence/index.js';
export type { PersistenceBackend } from './kernel/persistence/index.js';
export { serialize, deserialize } from './kernel/persistence/index.js';
export type { SerializedNode } from './kernel/persistence/index.js';

// Commands
export { CommandRegistry, createDefaultRegistry } from './commands/registry.js';
export type {
	Command,
	CommandContext,
	CommandOutputStream,
	CommandInputStream,
} from './commands/types.js';

// Factory commands
export { createPsCommand } from './commands/system/ps.js';
export { createTopCommand } from './commands/system/top.js';
export { createKillCommand } from './commands/system/kill.js';
export { createWatchCommand } from './commands/system/watch.js';
export { createHelpCommand } from './commands/system/help.js';
export { createNodeCommand, transformEsmToCjs } from './commands/system/node.js';
export { createCurlCommand } from './commands/net/curl.js';
export { createTunnelCommandV2 } from './commands/net/tunnel-v2.js';
export { ServiceWorkerBridge } from './kernel/network/ServiceWorkerBridge.js';
export { createIfconfigCommand } from './commands/net/ifconfig.js';
export { createRouteCommand } from './commands/net/route.js';
export { createNetstatCommand } from './commands/net/netstat.js';
export { createHostCommand } from './commands/net/host.js';
export { createIPCommand } from './commands/net/ip.js';
export { createTunnelCommand } from './commands/net/tunnel.js';
export { createForwardCommand, createUnforwardCommand } from './commands/net/forward.js';
export { createPortsCommand } from './commands/net/ports.js';
export { createTestRegistryCommand } from './commands/net/test-registry.js';
export { createLifoPkgCommand, bootLifoPackages, rehydrateGlobalPackages } from './commands/system/lifo.js';
export { createNpmCommand, createNpxCommand } from './commands/system/npm.js';
export { createLogoutCommand } from './commands/system/logout.js';
export { createSystemctlCommand } from './commands/system/systemctl.js';
export { createNewtabCommand } from './commands/system/newtab.js';

// Service manager
export { ServiceManager } from './kernel/ServiceManager.js';
export type { ServiceInfo } from './kernel/ServiceManager.js';
export type { UnitFile } from './kernel/unit-parser.js';
export { parseUnitFile } from './kernel/unit-parser.js';

// Shell
export { Shell } from './shell/Shell.js';
export { JobTable } from './shell/jobs.js';
export { ProcessRegistry } from './shell/ProcessRegistry.js';
export type { Process, SpawnOptions } from './shell/ProcessRegistry.js';

// Terminal
export type { ITerminal } from './terminal/ITerminal.js';
export { HeadlessTerminal } from './sandbox/HeadlessTerminal.js';

// Lifo runtime
export { createLifoCommand, readLifoManifest } from './pkg/lifo-runtime.js';
export type { LifoAPI, LifoPackageManifest } from './pkg/lifo-runtime.js';
export { linkPackage, unlinkPackage, loadDevLinks } from './pkg/lifo-dev.js';
export type { DevLink, DevLinksMap } from './pkg/lifo-dev.js';

// Node compatibility
export { createModuleMap, ProcessExitError } from './node-compat/index.js';
export type { NodeContext } from './node-compat/index.js';
export { Buffer } from './node-compat/buffer.js';

// Path utilities
export { resolve, dirname, join, normalize, basename, extname } from './utils/path.js';

// Color utilities
export {
	RESET,
	BOLD,
	DIM,
	ITALIC,
	UNDERLINE,
	RED,
	GREEN,
	YELLOW,
	BLUE,
	MAGENTA,
	CYAN,
	WHITE,
	BRIGHT_RED,
	BRIGHT_GREEN,
	BRIGHT_YELLOW,
	BRIGHT_BLUE,
	BRIGHT_MAGENTA,
	BRIGHT_CYAN,
	red,
	green,
	yellow,
	blue,
	magenta,
	cyan,
	bold,
	dim,
} from './utils/colors.js';
