import type { ITerminal } from '../terminal/ITerminal.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandOutputStream } from '../commands/types.js';
import { resolve } from '../utils/path.js';
import { BOLD, GREEN, BLUE, RESET } from '../utils/colors.js';
import { VFSError } from '../kernel/vfs/index.js';
import { Interpreter, type BuiltinFn, type InterpreterConfig } from './interpreter.js';
import { HistoryManager } from './history.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { complete, type CompletionContext } from './completer.js';
import { evaluateTest } from './test-builtin.js';
import { TerminalStdin } from './terminal-stdin.js';

export interface ExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  stdin?: string;
}

export class Shell {
  private terminal: ITerminal;
  private vfs: VFS;
  private registry: CommandRegistry;
  private cwd: string;
  private env: Record<string, string>;

  // Alias map
  private aliases = new Map<string, string>();

  // Line editing state
  private lineBuffer: string = '';
  private cursorPos: number = 0;
  private screenCursorRow: number = 0; // tracks the actual terminal row (relative to prompt start)

  // History (legacy array kept for backward compat with tests)
  private history: string[] = [];
  private historyIndex: number = -1;
  private savedLine: string = '';

  // Running command
  private running: boolean = false;
  private abortController: AbortController | null = null;
  private terminalStdin: TerminalStdin | null = null;
  private stdinLineBuffer: string = '';
  private stdinCursorPos: number = 0;

  // New Sprint 2 components
  private interpreter: Interpreter;
  private interpreterConfig: InterpreterConfig;
  private historyManager: HistoryManager;
  private jobTable: JobTable;
  private processRegistry: ProcessRegistry;
  private builtins: Map<string, BuiltinFn>;

  // Tab completion state
  private tabCount: number = 0;

  // Paste queue for multiline paste support
  private pasteQueue: string[] = [];

  constructor(
    terminal: ITerminal,
    vfs: VFS,
    registry: CommandRegistry,
    env: Record<string, string>,
    processRegistry: ProcessRegistry,
  ) {
    this.terminal = terminal;
    this.vfs = vfs;
    this.registry = registry;
    this.cwd = env['HOME'] ?? '/home/user';
    this.env = { ...env };

    // Initialize builtins
    this.builtins = new Map<string, BuiltinFn>();
    this.registerBuiltins();

    // Initialize job table (legacy - still used for backward compat)
    this.jobTable = new JobTable();

    // Use shared process registry from Kernel
    this.processRegistry = processRegistry;

    // Initialize history manager
    this.historyManager = new HistoryManager(vfs);
    this.historyManager.load();

    // Initialize interpreter
    this.interpreterConfig = {
      env: this.env,
      getCwd: () => this.cwd,
      setCwd: (cwd: string) => { this.cwd = cwd; },
      vfs: this.vfs,
      registry: this.registry,
      builtins: this.builtins,
      jobTable: this.jobTable,
      processRegistry: this.processRegistry,
      writeToTerminal: (text: string) => this.writeToTerminal(text),
      aliases: this.aliases,
      getAbortSignal: () => this.abortController?.signal ?? new AbortController().signal,
    };
    this.interpreter = new Interpreter(this.interpreterConfig);
  }

  private registerBuiltins(): void {
    this.builtins.set('cd', (args, _stdout, stderr) => this.builtinCd(args, stderr));
    this.builtins.set('pwd', (_args, stdout) => this.builtinPwd(stdout));
    this.builtins.set('echo', (args, stdout) => this.builtinEcho(args, stdout));
    this.builtins.set('clear', () => this.builtinClear());
    this.builtins.set('export', (args) => this.builtinExport(args));
    this.builtins.set('exit', (_args, stdout) => this.builtinExit(stdout));
    this.builtins.set('true', () => Promise.resolve(0));
    this.builtins.set('false', () => Promise.resolve(1));
    this.builtins.set('jobs', (_args, stdout) => this.builtinJobs(stdout));
    this.builtins.set('fg', (args, stdout, stderr) => this.builtinFg(args, stdout, stderr));
    this.builtins.set('bg', (args, stdout, stderr) => this.builtinBg(args, stdout, stderr));
    this.builtins.set('history', (_args, stdout) => this.builtinHistory(stdout));
    this.builtins.set('source', (args, _stdout, stderr) => this.builtinSource(args, stderr));
    this.builtins.set('.', (args, _stdout, stderr) => this.builtinSource(args, stderr));
    this.builtins.set('alias', (args, stdout) => this.builtinAlias(args, stdout));
    this.builtins.set('unalias', (args, _stdout, stderr) => this.builtinUnalias(args, stderr));
    this.builtins.set('test', (_args, _stdout, stderr) =>
      Promise.resolve(evaluateTest(_args, this.vfs, stderr)));
    this.builtins.set('[', (_args, _stdout, stderr) =>
      Promise.resolve(evaluateTest(_args, this.vfs, stderr)));
  }

  getJobTable(): JobTable {
    return this.jobTable;
  }

  getProcessRegistry(): ProcessRegistry {
    return this.processRegistry;
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  getEnv(): Record<string, string> {
    return this.env;
  }

  getVfs(): VFS {
    return this.vfs;
  }

  getRegistry(): CommandRegistry {
    return this.registry;
  }

  /**
   * Programmatic command execution with captured stdout/stderr.
   * Used by Sandbox.commands.run() for headless mode.
   */
  private _executeDepth = 0;

  async execute(
    cmd: string,
    options?: ExecuteOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this._executeDepth++;
    if (this._executeDepth > 10) {
      this._executeDepth--;
      const msg = `shell.execute: recursion depth exceeded (cmd="${cmd}")\n`;
      options?.onStderr?.(msg);
      return { stdout: '', stderr: msg, exitCode: 1 };
    }
    let stdoutBuf = '';
    let stderrBuf = '';

    const stdoutStream: CommandOutputStream = {
      write: (text: string) => {
        stdoutBuf += text;
        options?.onStdout?.(text);
      },
    };
    const stderrStream: CommandOutputStream = {
      write: (text: string) => {
        stderrBuf += text;
        options?.onStderr?.(text);
      },
    };

    // Save current state
    const prevDefaultStdout = this.interpreterConfig.defaultStdout;
    const prevDefaultStderr = this.interpreterConfig.defaultStderr;
    const prevWriteToTerminal = this.interpreterConfig.writeToTerminal;
    const prevCwd = options?.cwd ? this.cwd : undefined;

    // Redirect output
    this.interpreterConfig.defaultStdout = stdoutStream;
    this.interpreterConfig.defaultStderr = stderrStream;
    this.interpreterConfig.writeToTerminal = (text: string) => {
      stderrBuf += text;
      options?.onStderr?.(text);
    };

    // Apply per-call overrides
    if (options?.cwd) {
      this.cwd = options.cwd;
    }
    if (options?.env) {
      Object.assign(this.env, options.env);
    }

    // Handle stdin
    let terminalStdin: TerminalStdin | undefined;
    if (options?.stdin !== undefined) {
      terminalStdin = new TerminalStdin();
      terminalStdin.feed(options.stdin);
      terminalStdin.close();
    }

    try {
      const exitCode = await this.interpreter.executeLine(cmd, terminalStdin);
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
    } catch (e) {
      const msg = e instanceof Error ? (e.stack || e.message) : String(e);
      stderrBuf += msg + '\n';
      options?.onStderr?.(msg + '\n');
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: 1 };
    } finally {
      this._executeDepth--;
      // Restore state
      this.interpreterConfig.defaultStdout = prevDefaultStdout;
      this.interpreterConfig.defaultStderr = prevDefaultStderr;
      this.interpreterConfig.writeToTerminal = prevWriteToTerminal;
      if (prevCwd !== undefined) {
        this.cwd = prevCwd;
      }
    }
  }

  start(): void {
    // Register this shell instance as a process
    // First shell gets PID 1, subsequent shells get PID 2, 3, etc.
    const shellPromise = new Promise<number>(() => {}); // Never resolves (shell runs forever)
    const shellAbortController = new AbortController();

    this.processRegistry.spawn({
      command: 'shell',
      args: ['shell'],
      cwd: this.cwd,
      env: this.env,
      isForeground: true,
      promise: shellPromise,
      abortController: shellAbortController,
    });

    this.terminal.onData((data) => this.handleInput(data));

    // Source rc files on startup (like bash/zsh)
    this.sourceRcFiles().then(() => {
      this.printPrompt();
    });
  }

  private async sourceRcFiles(): Promise<void> {
    const home = this.env['HOME'] ?? '/home/user';

    // Source system-wide profile first
    await this.sourceFile('/etc/profile');

    // Then user rc files (first one found wins, like bash)
    const rcFiles = [
      `${home}/.liforc`,
      `${home}/.bashrc`,
      `${home}/.profile`,
    ];

    for (const rc of rcFiles) {
      if (this.vfs.exists(rc)) {
        await this.sourceFile(rc);
        break;
      }
    }
  }

  private printPrompt(): void {
    // Report finished background jobs from JobTable (legacy)
    const doneJobs = this.jobTable.collectDone();
    for (const job of doneJobs) {
      this.writeToTerminal(`[${job.id}] Done    ${job.command}\n`);
    }

    // Collect and reap zombie processes from ProcessRegistry
    this.processRegistry.collectZombies();
    // Zombies are already logged by JobTable above, so no need to log again

    const home = this.env['HOME'] ?? '/home/user';
    let displayPath = this.cwd;
    if (this.cwd === home) {
      displayPath = '~';
    } else if (this.cwd.startsWith(home + '/')) {
      displayPath = '~' + this.cwd.slice(home.length);
    }

    const user = this.env['USER'] ?? 'user';
    const host = this.env['HOSTNAME'] ?? 'lifo';
    this.terminal.write(`${BOLD}${GREEN}${user}@${host}${RESET}:${BOLD}${BLUE}${displayPath}${RESET}$ `);
  }

  private handleInput(data: string): void {
    // Raw mode: bypass all shell line editing, deliver keypresses directly
    if (this.running && this.terminalStdin?.rawMode) {
      this.terminalStdin.feed(data);
      return;
    }

    // Multiline paste detection: if data contains newlines and has multiple chars,
    // split into lines and execute them sequentially via the paste queue
    if (!this.running && data.length > 1 && /[\r\n]/.test(data)) {
      const lines = data.split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i++) {
        const segment = lines[i];
        if (i === 0) {
          // First segment: append to current lineBuffer and execute
          if (segment) {
            this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + segment + this.lineBuffer.slice(this.cursorPos);
            this.cursorPos += segment.length;
          }
          if (i < lines.length - 1) {
            // There's a newline after this segment, execute it
            this.redrawLine();
            this.terminal.write('\r\n');
            const line = this.lineBuffer.trim();
            this.lineBuffer = '';
            this.cursorPos = 0;
            this.historyIndex = -1;
            if (line) {
              this.history.push(line);
              // Queue remaining lines before executing
              for (let j = 1; j < lines.length - 1; j++) {
                if (lines[j]) this.pasteQueue.push(lines[j]);
              }
              // Last segment (after final newline) goes into lineBuffer without executing
              const lastSegment = lines[lines.length - 1];
              if (lastSegment) {
                this.pasteQueue.push(lastSegment);
              }
              this.executeLine(line);
              return;
            } else {
              // Empty first line, queue the rest
              for (let j = 1; j < lines.length - 1; j++) {
                if (lines[j]) this.pasteQueue.push(lines[j]);
              }
              const lastSegment = lines[lines.length - 1];
              if (lastSegment) {
                this.pasteQueue.push(lastSegment);
              }
              this.drainPasteQueue();
              return;
            }
          }
        }
      }
      // If we get here, data had newlines but only one segment (shouldn't happen)
      // Fall through to normal handling
      if (this.lineBuffer) this.redrawLine();
      return;
    }

    // ESC sequences
    if (data === '\x1b[D') { this.moveCursorLeft(); return; }
    if (data === '\x1b[C') { this.moveCursorRight(); return; }
    if (data === '\x1b[A') { this.historyUp(); return; }
    if (data === '\x1b[B') { this.historyDown(); return; }
    if (data === '\x1b[H' || data === '\x01') { this.moveCursorHome(); return; } // Home / Ctrl+A
    if (data === '\x1b[F' || data === '\x05') { this.moveCursorEnd(); return; }  // End / Ctrl+E

    // Ctrl+C
    if (data === '\x03') {
      if (this.running && this.abortController) {
        this.terminalStdin?.close();
        this.stdinLineBuffer = '';
        this.stdinCursorPos = 0;
        this.abortController.abort();
      } else {
        this.terminal.write('^C\r\n');
        this.lineBuffer = '';
        this.cursorPos = 0;
        this.screenCursorRow = 0;
        this.printPrompt();
      }
      return;
    }

    // Ctrl+D (EOF)
    if (data === '\x04') {
      if (this.running && this.terminalStdin && this.stdinLineBuffer.length === 0) {
        this.terminalStdin.close();
        return;
      }
      // When not running, Ctrl+D on empty line does nothing (or could exit)
      return;
    }

    // Ctrl+U -- clear line
    if (data === '\x15') {
      if (this.running && this.terminalStdin?.isWaiting) {
        // Clear the stdin line buffer
        if (this.stdinCursorPos > 0) {
          this.terminal.write(`\x1b[${this.stdinCursorPos}D`);
        }
        this.terminal.write('\x1b[K');
        this.stdinLineBuffer = '';
        this.stdinCursorPos = 0;
        return;
      }
      // Use redrawLine to clear wrapped content, then reset
      this.lineBuffer = '';
      this.cursorPos = 0;
      this.redrawLine();
      return;
    }

    // When a command is running and waiting for stdin, forward input
    if (this.running && this.terminalStdin?.isWaiting) {
      this.handleStdinInput(data);
      return;
    }

    if (this.running) return;

    // Tab completion
    if (data === '\t') {
      this.handleTab();
      return;
    }

    // Reset tab state on any non-tab input
    this.tabCount = 0;

    // Enter
    if (data === '\r') {
      this.terminal.write('\r\n');
      const line = this.lineBuffer.trim();
      this.lineBuffer = '';
      this.cursorPos = 0;
      this.screenCursorRow = 0;
      this.historyIndex = -1;

      if (line) {
        this.history.push(line);
        this.executeLine(line);
      } else {
        this.printPrompt();
      }
      return;
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (this.cursorPos > 0) {
        const before = this.lineBuffer.slice(0, this.cursorPos - 1);
        const after = this.lineBuffer.slice(this.cursorPos);
        this.lineBuffer = before + after;
        this.cursorPos--;
        this.redrawLine();
      }
      return;
    }

    // Delete
    if (data === '\x1b[3~') {
      if (this.cursorPos < this.lineBuffer.length) {
        const before = this.lineBuffer.slice(0, this.cursorPos);
        const after = this.lineBuffer.slice(this.cursorPos + 1);
        this.lineBuffer = before + after;
        this.redrawLine();
      }
      return;
    }

    // Printable characters
    if (data >= ' ') {
      // Insert at cursor
      const before = this.lineBuffer.slice(0, this.cursorPos);
      const after = this.lineBuffer.slice(this.cursorPos);
      this.lineBuffer = before + data + after;
      this.cursorPos += data.length;
      this.redrawLine();
    }
  }

  private handleTab(): void {
    const completionCtx: CompletionContext = {
      line: this.lineBuffer,
      cursorPos: this.cursorPos,
      cwd: this.cwd,
      env: this.env,
      vfs: this.vfs,
      registry: this.registry,
      builtinNames: [...this.builtins.keys()],
    };

    const result = complete(completionCtx);
    const currentWord = this.lineBuffer.slice(result.replacementStart, result.replacementEnd);

    if (result.completions.length === 0) {
      // No completions -- bell
      this.terminal.write('\x07');
      return;
    }

    if (result.completions.length === 1) {
      // Single completion -- insert it
      const completion = result.completions[0];
      const suffix = completion.endsWith('/') ? '' : ' ';
      this.applyCompletion(result.replacementStart, result.replacementEnd, completion + suffix);
      this.tabCount = 0;
      return;
    }

    // Multiple completions
    if (result.commonPrefix.length > currentWord.length) {
      // Extend to common prefix
      this.applyCompletion(result.replacementStart, result.replacementEnd, result.commonPrefix);
      this.tabCount = 0;
      return;
    }

    // Same word as before -- second tab shows all completions
    this.tabCount++;
    if (this.tabCount >= 2) {
      this.terminal.write('\r\n');
      this.writeToTerminal(result.completions.join('  ') + '\n');
      this.printPrompt();
      this.terminal.write(this.lineBuffer);
      // Move cursor to correct position
      const diff = this.lineBuffer.length - this.cursorPos;
      if (diff > 0) {
        this.terminal.write(`\x1b[${diff}D`);
      }
      this.tabCount = 0;
    }
  }

  private handleStdinInput(data: string): void {
    // Arrow keys for line editing
    if (data === '\x1b[D') {
      // Left arrow
      if (this.stdinCursorPos > 0) {
        this.stdinCursorPos--;
        this.terminal.write('\x1b[D');
      }
      return;
    }
    if (data === '\x1b[C') {
      // Right arrow
      if (this.stdinCursorPos < this.stdinLineBuffer.length) {
        this.stdinCursorPos++;
        this.terminal.write('\x1b[C');
      }
      return;
    }
    if (data === '\x1b[H' || data === '\x01') {
      // Home / Ctrl+A
      if (this.stdinCursorPos > 0) {
        this.terminal.write(`\x1b[${this.stdinCursorPos}D`);
        this.stdinCursorPos = 0;
      }
      return;
    }
    if (data === '\x1b[F' || data === '\x05') {
      // End / Ctrl+E
      const diff = this.stdinLineBuffer.length - this.stdinCursorPos;
      if (diff > 0) {
        this.terminal.write(`\x1b[${diff}C`);
        this.stdinCursorPos = this.stdinLineBuffer.length;
      }
      return;
    }

    // Ignore other escape sequences (up/down arrows, etc.)
    if (data.startsWith('\x1b')) return;

    // Enter -- feed line to stdin
    if (data === '\r') {
      this.terminal.write('\r\n');
      this.terminalStdin!.feed(this.stdinLineBuffer + '\n');
      this.stdinLineBuffer = '';
      this.stdinCursorPos = 0;
      return;
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (this.stdinCursorPos > 0) {
        const before = this.stdinLineBuffer.slice(0, this.stdinCursorPos - 1);
        const after = this.stdinLineBuffer.slice(this.stdinCursorPos);
        this.stdinLineBuffer = before + after;
        this.stdinCursorPos--;
        // Redraw: move back, write rest + space to clear, reposition cursor
        this.terminal.write('\b' + after + ' ');
        // Move cursor back to position
        const moveBack = after.length + 1;
        if (moveBack > 0) {
          this.terminal.write(`\x1b[${moveBack}D`);
        }
      }
      return;
    }

    // Printable characters
    if (data >= ' ') {
      const before = this.stdinLineBuffer.slice(0, this.stdinCursorPos);
      const after = this.stdinLineBuffer.slice(this.stdinCursorPos);
      this.stdinLineBuffer = before + data + after;
      this.stdinCursorPos += data.length;
      // Write char + rest of line, reposition cursor
      this.terminal.write(data + after);
      if (after.length > 0) {
        this.terminal.write(`\x1b[${after.length}D`);
      }
    }
  }

  private applyCompletion(start: number, end: number, text: string): void {
    const before = this.lineBuffer.slice(0, start);
    const after = this.lineBuffer.slice(end);
    this.lineBuffer = before + text + after;
    this.cursorPos = start + text.length;
    this.redrawLine();
  }

  private getPromptWidth(): number {
    const home = this.env['HOME'] ?? '/home/user';
    let displayPath = this.cwd;
    if (this.cwd === home) displayPath = '~';
    else if (this.cwd.startsWith(home + '/')) displayPath = '~' + this.cwd.slice(home.length);
    const user = this.env['USER'] ?? 'user';
    const host = this.env['HOSTNAME'] ?? 'lifo';
    // "user@host:path$ " — count visible chars only (no ANSI codes)
    return user.length + 1 + host.length + 1 + displayPath.length + 2;
  }

  private redrawLine(): void {
    const cols = this.terminal.cols;
    const promptWidth = this.getPromptWidth();
    const totalLen = promptWidth + this.lineBuffer.length;

    // Move up from wherever the cursor actually is to the prompt start row
    if (this.screenCursorRow > 0) {
      this.terminal.write(`\x1b[${this.screenCursorRow}A`);
    }
    this.terminal.write('\r');

    // Clear from here to end of screen
    this.terminal.write('\x1b[J');

    // Rewrite prompt + buffer
    const home = this.env['HOME'] ?? '/home/user';
    let displayPath = this.cwd;
    if (this.cwd === home) {
      displayPath = '~';
    } else if (this.cwd.startsWith(home + '/')) {
      displayPath = '~' + this.cwd.slice(home.length);
    }
    const user = this.env['USER'] ?? 'user';
    const host = this.env['HOSTNAME'] ?? 'lifo';
    this.terminal.write(`${BOLD}${GREEN}${user}@${host}${RESET}:${BOLD}${BLUE}${displayPath}${RESET}$ `);
    this.terminal.write(this.lineBuffer);

    // After writing all content, figure out which row the cursor is on.
    // If content exactly fills N rows, the terminal auto-wraps cursor to the next row.
    let endRow: number;
    if (totalLen > 0 && totalLen % cols === 0) {
      endRow = totalLen / cols; // cursor wraps to one row past the last content row
    } else {
      endRow = Math.floor(totalLen / cols);
    }

    // Position cursor at the desired column
    const desiredCol = promptWidth + this.cursorPos;
    const desiredRow = Math.floor(desiredCol / cols);

    // Move up from content end to desired row
    const rowDiff = endRow - desiredRow;
    if (rowDiff > 0) {
      this.terminal.write(`\x1b[${rowDiff}A`);
    }
    // Move to correct column within the row
    const colInRow = desiredCol % cols;
    this.terminal.write('\r');
    if (colInRow > 0) {
      this.terminal.write(`\x1b[${colInRow}C`);
    }

    // Track where we left the cursor
    this.screenCursorRow = desiredRow;
  }

  private drainPasteQueue(): void {
    const next = this.pasteQueue.shift();
    if (next !== undefined) {
      const line = next.trim();
      if (line) {
        this.terminal.write(line);
        this.terminal.write('\r\n');
        this.history.push(line);
        this.executeLine(line);
      } else {
        // Skip empty lines, try next
        this.drainPasteQueue();
      }
    }
  }

  private moveCursorLeft(): void {
    if (this.cursorPos > 0) {
      this.cursorPos--;
      this.terminal.write('\x1b[D');
    }
  }

  private moveCursorRight(): void {
    if (this.cursorPos < this.lineBuffer.length) {
      this.cursorPos++;
      this.terminal.write('\x1b[C');
    }
  }

  private moveCursorHome(): void {
    if (this.cursorPos > 0) {
      this.terminal.write(`\x1b[${this.cursorPos}D`);
      this.cursorPos = 0;
    }
  }

  private moveCursorEnd(): void {
    const diff = this.lineBuffer.length - this.cursorPos;
    if (diff > 0) {
      this.terminal.write(`\x1b[${diff}C`);
      this.cursorPos = this.lineBuffer.length;
    }
  }

  private historyUp(): void {
    if (this.history.length === 0) return;

    if (this.historyIndex === -1) {
      this.savedLine = this.lineBuffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }

    this.lineBuffer = this.history[this.historyIndex];
    this.cursorPos = this.lineBuffer.length;
    this.redrawLine();
  }

  private historyDown(): void {
    if (this.historyIndex === -1) return;

    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.lineBuffer = this.history[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.lineBuffer = this.savedLine;
    }

    this.cursorPos = this.lineBuffer.length;
    this.redrawLine();
  }

  private async executeLine(line: string): Promise<void> {
    // History expansion
    const expanded = this.historyManager.expand(line);
    const actualLine = expanded ?? line;

    if (expanded !== null) {
      // Show the expanded command
      this.writeToTerminal(actualLine + '\n');
    }

    // Add to history
    this.historyManager.add(actualLine);

    this.running = true;
    this.abortController = new AbortController();
    this.terminalStdin = new TerminalStdin();

    try {
      await this.interpreter.executeLine(actualLine, this.terminalStdin);
    } finally {
      this.terminalStdin?.close();
      this.terminalStdin = null;
      this.stdinLineBuffer = '';
      this.stdinCursorPos = 0;
      this.running = false;
      this.abortController = null;
    }

    this.printPrompt();
    this.drainPasteQueue();
  }

  // ─── Builtins (now with stdout/stderr params for pipe support) ───

  private async builtinCd(args: string[], stderr: CommandOutputStream): Promise<number> {
    const target = args[0] ?? this.env['HOME'] ?? '/home/user';
    let newPath: string;

    if (target === '-') {
      newPath = this.env['OLDPWD'] ?? this.cwd;
    } else if (target === '~' || target.startsWith('~/')) {
      const home = this.env['HOME'] ?? '/home/user';
      newPath = target === '~' ? home : resolve(home, target.slice(2));
    } else {
      newPath = resolve(this.cwd, target);
    }

    try {
      const stat = this.vfs.stat(newPath);
      if (stat.type !== 'directory') {
        stderr.write(`cd: ${target}: Not a directory\n`);
        return 1;
      }
      this.env['OLDPWD'] = this.cwd;
      this.cwd = newPath;
      return 0;
    } catch (e) {
      if (e instanceof VFSError) {
        stderr.write(`cd: ${target}: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }

  private async builtinPwd(stdout: CommandOutputStream): Promise<number> {
    stdout.write(this.cwd + '\n');
    return 0;
  }

  private async builtinEcho(args: string[], stdout: CommandOutputStream): Promise<number> {
    stdout.write(args.join(' ') + '\n');
    return 0;
  }

  private async builtinClear(): Promise<number> {
    this.terminal.clear();
    return 0;
  }

  private async builtinExport(args: string[]): Promise<number> {
    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        this.env[key] = value;
      }
    }
    return 0;
  }

  private async builtinExit(stdout: CommandOutputStream): Promise<number> {
    stdout.write('logout\n');
    return 0;
  }

  private async builtinJobs(stdout: CommandOutputStream): Promise<number> {
    const jobs = this.jobTable.list();
    for (const job of jobs) {
      stdout.write(`[${job.id}] ${job.status}    ${job.command}\n`);
    }
    return 0;
  }

  private async builtinFg(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    const id = args[0] ? parseInt(args[0], 10) : undefined;
    const jobs = this.jobTable.list();

    if (jobs.length === 0) {
      stderr.write('fg: no current job\n');
      return 1;
    }

    const job = id ? this.jobTable.get(id) : jobs[jobs.length - 1];
    if (!job) {
      stderr.write(`fg: ${id}: no such job\n`);
      return 1;
    }

    stdout.write(`${job.command}\n`);
    const exitCode = await job.promise;
    this.jobTable.remove(job.id);
    return exitCode;
  }

  private async builtinBg(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    const id = args[0] ? parseInt(args[0], 10) : undefined;
    const jobs = this.jobTable.list();

    if (jobs.length === 0) {
      stderr.write('bg: no current job\n');
      return 1;
    }

    const job = id ? this.jobTable.get(id) : jobs[jobs.length - 1];
    if (!job) {
      stderr.write(`bg: ${id}: no such job\n`);
      return 1;
    }

    stdout.write(`[${job.id}] ${job.command} &\n`);
    return 0;
  }

  private async builtinHistory(stdout: CommandOutputStream): Promise<number> {
    const entries = this.historyManager.getAll();
    for (let i = 0; i < entries.length; i++) {
      stdout.write(`  ${i + 1}  ${entries[i]}\n`);
    }
    return 0;
  }

  async sourceFile(path: string): Promise<void> {
    try {
      const content = this.vfs.readFileString(path);
      await this.interpreter.executeLine(content);
    } catch {
      // Silently ignore missing config files
    }
  }

  private async builtinSource(args: string[], stderr: CommandOutputStream): Promise<number> {
    if (args.length === 0) {
      stderr.write('source: missing filename\n');
      return 1;
    }
    const path = resolve(this.cwd, args[0]);
    try {
      const content = this.vfs.readFileString(path);
      await this.interpreter.executeLine(content);
      return 0;
    } catch {
      stderr.write(`source: ${args[0]}: No such file\n`);
      return 1;
    }
  }

  private async builtinAlias(args: string[], stdout: CommandOutputStream): Promise<number> {
    if (args.length === 0) {
      for (const [name, value] of this.aliases) {
        stdout.write(`alias ${name}='${value}'\n`);
      }
      return 0;
    }

    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const name = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        this.aliases.set(name, value);
      } else {
        const value = this.aliases.get(arg);
        if (value !== undefined) {
          stdout.write(`alias ${arg}='${value}'\n`);
        } else {
          stdout.write(`alias: ${arg}: not found\n`);
        }
      }
    }
    return 0;
  }

  private async builtinUnalias(args: string[], stderr: CommandOutputStream): Promise<number> {
    if (args.length === 0) {
      stderr.write('unalias: usage: unalias name ...\n');
      return 1;
    }
    for (const name of args) {
      if (!this.aliases.delete(name)) {
        stderr.write(`unalias: ${name}: not found\n`);
      }
    }
    return 0;
  }

  private writeToTerminal(text: string): void {
    // Convert \n to \r\n for xterm.js
    const converted = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    this.terminal.write(converted);
  }

  // ─── Legacy Tokenizer (kept for backward compatibility) ───

  tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    while (i < input.length) {
      const ch = input[i];

      if (inSingle) {
        if (ch === "'") {
          inSingle = false;
        } else {
          current += ch;
        }
        i++;
        continue;
      }

      if (inDouble) {
        if (ch === '"') {
          inDouble = false;
        } else {
          current += ch;
        }
        i++;
        continue;
      }

      if (ch === "'") {
        inSingle = true;
        i++;
        continue;
      }

      if (ch === '"') {
        inDouble = true;
        i++;
        continue;
      }

      if (ch === ' ' || ch === '\t') {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
        i++;
        continue;
      }

      // Handle &&
      if (ch === '&' && input[i + 1] === '&') {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
        tokens.push('&&');
        i += 2;
        continue;
      }

      current += ch;
      i++;
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }
}
