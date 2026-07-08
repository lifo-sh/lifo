import type { VFS } from '../kernel/vfs/index.js';

export interface CommandOutputStream {
  write(text: string): void;
}

export interface CommandInputStream {
  read(): Promise<string | null>;   // null = EOF
  readAll(): Promise<string>;
}

export interface CommandContext {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  vfs: VFS;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  signal: AbortSignal;
  stdin?: CommandInputStream;
  setRawMode?: (enabled: boolean) => void;
  /**
   * Run a shell command line and capture its stdout. Backs child_process
   * (exec/spawn), so in-VM tools can shell out to other commands (e.g.
   * create-expo-app running `npm pack`). Optional cwd runs it elsewhere.
   */
  executeCapture?: (input: string, opts?: { cwd?: string }) => Promise<string>;
}

export type Command = (ctx: CommandContext) => Promise<number>;
