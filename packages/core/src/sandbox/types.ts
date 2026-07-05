import type { Command } from '../commands/types.js';
import type { Kernel } from '../kernel/index.js';
import type { Shell } from '../shell/Shell.js';
import type { ITerminal } from '../terminal/ITerminal.js';
import type { NativeFsModule } from '../kernel/vfs/providers/NativeFsProvider.js';

// ─── Sandbox Options ───

export interface SandboxOptions {
  /** Enable IndexedDB persistence (default: false) */
  persist?: boolean;
  /** Extra environment variables (merged with defaults) */
  env?: Record<string, string>;
  /** Initial working directory (default: /home/user) */
  cwd?: string;
  /** Pre-populate files: path → content */
  files?: Record<string, string | Uint8Array>;
  /**
   * Visual mode: a pre-created ITerminal, a container HTMLElement, or a CSS
   * selector string — the latter two lazily create an xterm.js Terminal from
   * @lifo-sh/ui (matches what Sandbox.create actually supports at runtime).
   */
  terminal?: ITerminal | HTMLElement | string;
  /**
   * Mount native filesystem directories into the virtual filesystem at boot time.
   * Only works in Node.js environments (or when a custom fsModule is provided).
   */
  mounts?: Array<{
    /** Path inside the virtual filesystem where the mount will appear */
    virtualPath: string;
    /** Host filesystem path to mount */
    hostPath: string;
    /** If true, the mount is read-only (default: false) */
    readOnly?: boolean;
    /** Custom fs module implementing NativeFsModule. If omitted, node:fs is used. */
    fsModule?: NativeFsModule;
  }>;
}

// ─── Command Execution ───

export interface RunOptions {
  /** Working directory for this command */
  cwd?: string;
  /** Extra environment variables for this command */
  env?: Record<string, string>;
  /** Abort signal to cancel the command */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Streaming stdout callback */
  onStdout?: (data: string) => void;
  /** Streaming stderr callback */
  onStderr?: (data: string) => void;
  /** Provide stdin content */
  stdin?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── SandboxCommands ───

export interface SandboxCommands {
  run(cmd: string, options?: RunOptions): Promise<CommandResult>;
  register(name: string, handler: Command): void;
}

// ─── SandboxFs ───

export interface SandboxFs {
  readFile(path: string): Promise<string>;
  readFile(path: string, encoding: null): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>>;
  stat(path: string): Promise<{ type: 'file' | 'directory'; size: number; mtime: number }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  cp(src: string, dest: string): Promise<void>;
  writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void>;
  /** Export entire VFS as a tar.gz snapshot */
  exportSnapshot(): Promise<Uint8Array>;
  /** Restore VFS from a tar.gz snapshot */
  importSnapshot(data: Uint8Array): Promise<void>;
}

// ─── Internal types for Sandbox internals ───

export interface SandboxInternals {
  kernel: Kernel;
  shell: Shell;
}
