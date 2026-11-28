import type { VFS } from '../kernel/vfs/index.js';

export interface CommandOutputStream {
  write(text: string): void;
  /** True when this stream is the interactive terminal (not a pipe, file or capture). */
  isTTY?: boolean;
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
  /**
   * Like executeCapture but also returns the exit code, letting child_process
   * emit an ENOENT `error` for a missing command (exit 127) as Node does.
   */
  executeCaptureResult?: (input: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
  /**
   * Run a shell command line as a child that shares this command's terminal: its output goes
   * where this command's goes, it reads this command's input, and stopping this command stops
   * it. Resolves with the child's exit code. The node command uses it to run what a program
   * asked for with spawnSync once the program has ended.
   */
  runInherited?: (input: string, opts?: { cwd?: string }) => Promise<number>;
}

export type Command = (ctx: CommandContext) => Promise<number>;
