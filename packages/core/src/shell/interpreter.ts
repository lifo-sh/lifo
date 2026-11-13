import type {
  ScriptNode,
  ListNode,
  PipelineNode,
  SimpleCommandNode,
  CompoundCommandNode,
  IfNode,
  ForNode,
  WhileNode,
  UntilNode,
  CaseNode,
  FunctionDefNode,
  GroupNode,
  SubshellNode,
  RedirectionNode,
} from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type {
  CommandOutputStream,
  CommandInputStream,
  CommandContext,
} from '../commands/types.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { commandRedirect } from './command-suggestions.js';
import { expandWords, expandWord, type ExpandContext } from './expander.js';
import { PipeChannel } from './pipe.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { resolve } from '../utils/path.js';
import { globMatch } from '../utils/glob.js';
import type { TerminalStdin } from './terminal-stdin.js';

// ─── Signal classes for control flow ───

export class BreakSignal {
  constructor(public levels: number) {}
}

export class ContinueSignal {
  constructor(public levels: number) {}
}

export class ReturnSignal {
  constructor(public exitCode: number) {}
}

/**
 * `exit` in a `( … )` subshell, a `$( … )` substitution or a programmatic run (commands.run,
 * npm scripts): ends that run with the code. At the interactive prompt, `exit` stays the
 * Shell's builtin (the CLI makes it quit).
 */
export class ExitSignal {
  constructor(public exitCode: number) {}
}

/** Shell pids for `$$`: each interpreter gets its own, stable for its lifetime. */
let nextShellPid = 1000;

export type BuiltinFn = (
  args: string[],
  stdout: CommandOutputStream,
  stderr: CommandOutputStream,
  stdin?: CommandInputStream,
) => Promise<number>;

/**
 * Per-execution fallback streams. Threaded through the execute chain so a
 * captured run (shell.execute with onStdout, executeCaptureResult) routes its
 * commands' output WITHOUT mutating the shared config — concurrent executions
 * (a running dev server + a probe command) previously clobbered each other's
 * defaultStdout, silently swallowing output.
 */
export interface StreamDefaults {
  stdout?: CommandOutputStream;
  stderr?: CommandOutputStream;
  /**
   * Abort signal for the commands run under these defaults. Threaded explicitly
   * (rather than via the mutable `config.getAbortSignal`) so a background job's
   * signal reaches its inner command even though `getAbortSignal` is restored
   * synchronously before the job's async body runs — without it, `kill <pid>`
   * on a background job never propagates to the process it spawned.
   */
  abortSignal?: AbortSignal;
  /**
   * Standard input for the commands run under these defaults: the pipe or redirect feeding a
   * compound command (`… | while read l; do …; done`, `{ …; } < file`), or the terminal.
   */
  stdin?: CommandInputStream;
  /**
   * The working directory of a background job or a `( … )` subshell: its own, shared by reference
   * through every copy of these defaults, so a `cd` inside it moves only it. A job keeps running
   * after the shell (or the `commands.run(…, { cwd })` that started it) has moved on.
   */
  scope?: { cwd: string };
}

export interface InterpreterConfig {
  env: Record<string, string>;
  getCwd: () => string;
  setCwd: (cwd: string) => void;
  vfs: VFS;
  registry: CommandRegistry;
  builtins: Map<string, BuiltinFn>;
  jobTable: JobTable;
  processRegistry: ProcessRegistry;
  writeToTerminal: (text: string) => void;
  aliases?: Map<string, string>;
  /** Override default stdout for programmatic capture */
  defaultStdout?: CommandOutputStream;
  /** Override default stderr for programmatic capture */
  defaultStderr?: CommandOutputStream;
  /** Returns the current abort signal for foreground commands */
  getAbortSignal?: () => AbortSignal;
  /** Internal flag: true when executing background job (don't register individual commands) */
  isBackgroundContext?: boolean;
}

export class Interpreter {
  private config: InterpreterConfig;
  private lastExitCode = 0;
  private functions = new Map<string, CompoundCommandNode>();
  /** `$$` */
  readonly pid = nextShellPid++;
  /** `$!` */
  private lastBackgroundPid: number | undefined;
  private subshellDepth = 0;
  /** > 0 while a programmatic run (Shell.execute, $( … )) is executing; see ExitSignal. */
  scriptDepth = 0;
  /** Variables declared with `local`, per active function call: name → value before the call. */
  private localScopes: Array<Map<string, string | undefined>> = [];
  /** Shell options set with `set -e` etc. Accepted for compatibility; not enforced yet. */
  readonly options = new Set<string>();
  /** Text read past a newline by `read`, per input stream, for the next `read`. */
  private readLeftovers = new WeakMap<CommandInputStream, string>();

  constructor(config: InterpreterConfig) {
    this.config = config;
  }

  getLastExitCode(): number {
    return this.lastExitCode;
  }

  async executeScript(script: ScriptNode, terminalStdin?: TerminalStdin, defaults?: StreamDefaults): Promise<number> {
    let exitCode = 0;
    for (const list of script.lists) {
      exitCode = await this.executeList(list, terminalStdin, defaults);
    }
    this.lastExitCode = exitCode;
    return exitCode;
  }

  async executeLine(input: string, terminalStdin?: TerminalStdin, defaults?: StreamDefaults): Promise<number> {
    try {
      const tokens = lex(input);
      const script = parse(tokens);
      return await this.executeScript(script, terminalStdin, defaults);
    } catch (e) {
      if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal || e instanceof ExitSignal) {
        throw e;
      }
      if (e instanceof Error) {
        if (defaults?.stderr) defaults.stderr.write(`${e.message}\n`);
        else this.config.writeToTerminal(`${e.message}\n`);
      }
      this.lastExitCode = 2;
      return 2;
    }
  }

  private async executeList(list: ListNode, terminalStdin?: TerminalStdin, defaults?: StreamDefaults): Promise<number> {
    if (list.background) {
      const abortController = new AbortController();
      const commandText = this.getListCommandText(list);

      // Set background context and override abort signal
      const wasBackgroundContext = this.config.isBackgroundContext;
      const wasGetAbortSignal = this.config.getAbortSignal;
      this.config.isBackgroundContext = true;
      this.config.getAbortSignal = () => abortController.signal;

      // Background jobs don't get terminal stdin. Thread the job's abort signal
      // through `defaults` so the inner command observes THIS controller (the
      // one `kill <pid>` aborts), not the parent signal that getAbortSignal is
      // restored to below before this async body reads it.
      const promise = this.executeListEntries(list.entries, undefined, {
        ...defaults,
        abortSignal: abortController.signal,
        scope: { cwd: defaults?.scope?.cwd ?? this.config.getCwd() },
      });

      // Restore config
      this.config.isBackgroundContext = wasBackgroundContext;
      this.config.getAbortSignal = wasGetAbortSignal;

      const jobId = this.config.jobTable.add(commandText, promise, abortController);

      // Register in ProcessRegistry as single background job
      const pid = this.config.processRegistry.spawn({
        command: commandText.split(' ')[0] || 'unknown',
        args: commandText.split(' '),
        cwd: this.config.getCwd(),
        env: { ...this.config.env },
        isForeground: false,
        promise,
        abortController,
      });

      this.lastBackgroundPid = pid;
      this.config.writeToTerminal(`[${jobId}] ${pid} (background)\n`);

      // Don't auto-reap - let Shell collect zombies before next prompt
      // This matches Linux behavior where zombies persist until reaped

      return 0;
    }

    return this.executeListEntries(list.entries, terminalStdin, defaults);
  }

  private getListCommandText(list: ListNode): string {
    return list.entries.map((e) =>
      e.pipeline.commands.map((c) => {
        if (c.type === 'simple_command') {
          return c.words.map((w) => w.map((p) => p.text).join('')).join(' ');
        }
        return c.type;
      }).join(' | '),
    ).join(' ');
  }

  private async executeListEntries(entries: ListNode['entries'], terminalStdin?: TerminalStdin, defaults?: StreamDefaults): Promise<number> {
    let exitCode = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      exitCode = await this.executePipeline(entry.pipeline, terminalStdin, defaults);

      // Check the connector on current entry to decide whether to continue
      if (entry.connector === '&&' && exitCode !== 0) {
        // Skip remaining entries until we find || or end
        break;
      }
      if (entry.connector === '||' && exitCode === 0) {
        // Skip remaining entries until we find && or end
        break;
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executePipeline(pipeline: PipelineNode, terminalStdin?: TerminalStdin, defaults?: StreamDefaults): Promise<number> {
    const commands = pipeline.commands;

    let exitCode: number;

    if (commands.length === 1) {
      // Single command -- no piping needed
      exitCode = await this.executeCommand(commands[0], undefined, undefined, terminalStdin, undefined, defaults);
    } else {
      // Multi-command pipeline -- only first command gets terminalStdin
      exitCode = await this.executePipelineCommands(commands, terminalStdin, defaults);
    }

    if (pipeline.negated) {
      exitCode = exitCode === 0 ? 1 : 0;
    }

    return exitCode;
  }

  private async executePipelineCommands(commands: CompoundCommandNode[], terminalStdin?: TerminalStdin, defaults?: StreamDefaults): Promise<number> {
    const pipes: PipeChannel[] = [];
    const promises: Promise<number>[] = [];

    for (let i = 0; i < commands.length; i++) {
      const stdin = i > 0 ? pipes[i - 1].reader : undefined;
      let stdout: CommandOutputStream | undefined;

      if (i < commands.length - 1) {
        const pipe = new PipeChannel();
        pipes.push(pipe);
        stdout = pipe.writer;
      }

      const cmd = commands[i];
      // Only the first command in a pipeline gets terminal stdin
      const tStdin = i === 0 ? terminalStdin : undefined;
      const cmdPromise = this.executeCommand(cmd, stdin, stdout, tStdin, undefined, defaults)
        .then((code) => {
          // Close the pipe writer when command finishes
          if (i < commands.length - 1) {
            pipes[i].close();
          }
          return code;
        });

      promises.push(cmdPromise);
    }

    const results = await Promise.all(promises);
    return results[results.length - 1];
  }

  private async executeCommand(
    cmd: CompoundCommandNode,
    pipeStdin?: CommandInputStream,
    pipeStdout?: CommandOutputStream,
    terminalStdin?: TerminalStdin,
    pipeStderr?: CommandOutputStream,
    defaults?: StreamDefaults,
  ): Promise<number> {
    // Compound bodies forward a pipeStdout to their inner commands; giving
    // them the per-execution default keeps captured runs (shell.execute /
    // executeCaptureResult) collecting compound output without touching the
    // SHARED interpreter config (which concurrent executions would clobber).
    if (cmd.type === 'simple_command') {
      return this.executeSimpleCommand(cmd, pipeStdin, pipeStdout, terminalStdin, pipeStderr, defaults);
    }
    if (cmd.type === 'function_def') return this.executeFunctionDef(cmd);

    const compoundOut = pipeStdout ?? defaults?.stdout;
    // What the commands inside a compound body (if/for/while/case/{ }/( )) write to and read
    // from: the pipe or capture this compound is connected to, then its own redirections
    // (`done < file`, `} > out`), plus the rest of the execution's defaults (abort signal).
    // Without it they fall back to the terminal, so `$(for ...)`, `for ... | head` and
    // sandbox.commands.run() saw no output from loops.
    let inner: StreamDefaults | undefined =
      compoundOut || defaults || pipeStdin || terminalStdin
        ? { ...defaults, stdout: compoundOut, stdin: pipeStdin ?? defaults?.stdin ?? terminalStdin }
        : undefined;
    if (cmd.redirections.length > 0) {
      const streams = await this.applyRedirections(cmd.redirections, {
        stdout: compoundOut ?? this.config.defaultStdout ?? this.terminalStream(),
        stderr: pipeStderr ?? defaults?.stderr ?? this.config.defaultStderr ?? this.terminalStream(),
        stdin: inner?.stdin,
      });
      inner = { ...defaults, ...streams };
    }
    switch (cmd.type) {      case 'if':
        return this.executeIf(cmd, inner);
      case 'for':
        return this.executeFor(cmd, inner);
      case 'while':
        return this.executeWhile(cmd, inner);
      case 'until':
        return this.executeUntil(cmd, inner);
      case 'case':
        return this.executeCase(cmd, inner);
      case 'group':
        return this.executeGroup(cmd, inner);
      case 'subshell':
        return this.executeSubshell(cmd, inner);
    }
  }

  private terminalStream(): CommandOutputStream {
    return { write: (text: string) => this.config.writeToTerminal(text), isTTY: true };
  }

  /** Applies redirections left to right, as bash does: `> f 2>&1` sends both to f, `2>&1 > f` doesn't. */
  private async applyRedirections(
    redirections: RedirectionNode[],
    streams: { stdout: CommandOutputStream; stderr: CommandOutputStream; stdin?: CommandInputStream },
    cwd: string = this.config.getCwd(),
  ): Promise<{ stdout: CommandOutputStream; stderr: CommandOutputStream; stdin?: CommandInputStream }> {
    let { stdout, stderr, stdin } = streams;
    const expandCtx = this.createExpandContext();
    for (const redir of redirections) {
      if (redir.operator === '2>&1') { stderr = stdout; continue; }
      if (redir.operator === '>&2') { stdout = stderr; continue; }
      if (redir.operator === '>&1') { continue; } // self-dup, no-op
      const target = await expandWord(redir.target, expandCtx);
      if (redir.operator === '<<') { stdin = this.createStringReader(target); continue; }
      if (redir.operator === '<<<') { stdin = this.createStringReader(target + '\n'); continue; }
      const targetPath = resolve(cwd, target);

      switch (redir.operator) {
        case '>':
          this.config.vfs.writeFile(targetPath, '');
          stdout = this.createFileWriter(targetPath);
          break;
        case '>>':
          if (!this.config.vfs.exists(targetPath)) {
            this.config.vfs.writeFile(targetPath, '');
          }
          stdout = this.createFileAppender(targetPath);
          break;
        case '<':
          stdin = this.createFileReader(targetPath);
          break;
        case '2>':
          this.config.vfs.writeFile(targetPath, '');
          stderr = this.createFileWriter(targetPath);
          break;
        case '2>>':
          if (!this.config.vfs.exists(targetPath)) {
            this.config.vfs.writeFile(targetPath, '');
          }
          stderr = this.createFileAppender(targetPath);
          break;
        case '&>':
          this.config.vfs.writeFile(targetPath, '');
          stdout = this.createFileWriter(targetPath);
          stderr = stdout;
          break;
      }
    }
    return { stdout, stderr, stdin };
  }

  /**
   * `( … )`: runs the body with copies of the variables, functions, aliases and working
   * directory, so nothing it changes (`cd`, `X=1`, `export`) reaches the parent shell.
   */
  private async executeSubshell(node: SubshellNode, inner?: StreamDefaults): Promise<number> {
    const env = this.config.env;
    const savedEnv = { ...env };
    const savedCwd = this.config.getCwd();
    const savedFunctions = new Map(this.functions);
    const savedAliases = this.config.aliases ? new Map(this.config.aliases) : undefined;
    this.subshellDepth++;
    let exitCode: number;
    try {
      // Its own working directory: a `cd` inside never reaches the parent (or a job it runs in).
      exitCode = await this.executeCompoundList(node.body, { ...inner, scope: { cwd: inner?.scope?.cwd ?? savedCwd } });
    } catch (e) {
      if (e instanceof ExitSignal) exitCode = e.exitCode;
      else throw e;
    } finally {
      this.subshellDepth--;
      // Restore in place: the env object is shared with the Shell and the Sandbox (box.env).
      for (const key of Object.keys(env)) if (!(key in savedEnv)) delete env[key];
      Object.assign(env, savedEnv);
      this.config.setCwd(savedCwd);
      this.functions = savedFunctions;
      if (savedAliases && this.config.aliases) {
        this.config.aliases.clear();
        for (const [k, v] of savedAliases) this.config.aliases.set(k, v);
      }
    }
    this.lastExitCode = exitCode;
    return exitCode;
  }

  /** Builtins that need the interpreter's own state (variables, functions, positional args). */
  private interpreterBuiltins: Record<
    string,
    (args: string[], stdin: CommandInputStream | undefined, stdout: CommandOutputStream, stderr: CommandOutputStream) => Promise<number>
  > = {
    read: (args, stdin, _stdout, stderr) => this.builtinRead(args, stdin, stderr),
    local: async (args, _stdin, _stdout, stderr) => {
      const scope = this.localScopes[this.localScopes.length - 1];
      if (!scope) {
        stderr.write('local: can only be used in a function\n');
        return 1;
      }
      for (const arg of args) {
        if (arg.startsWith('-')) continue; // -r, -a … accepted, not enforced
        const eq = arg.indexOf('=');
        const key = eq === -1 ? arg : arg.slice(0, eq);
        if (!scope.has(key)) scope.set(key, this.config.env[key]);
        this.config.env[key] = eq === -1 ? (this.config.env[key] ?? '') : arg.slice(eq + 1);
      }
      return 0;
    },
    shift: async (args, _stdin, _stdout, stderr) => {
      const n = args[0] ? parseInt(args[0], 10) : 1;
      const current = this.positionals();
      if (!(n >= 0) || n > current.length) {
        stderr.write(`shift: ${args[0] ?? n}: shift count out of range\n`);
        return 1;
      }
      this.setPositionals(current.slice(n));
      return 0;
    },
    set: async (args, _stdin, stdout) => {
      if (args.length === 0) {
        for (const key of Object.keys(this.config.env).sort()) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) stdout.write(`${key}=${this.config.env[key]}\n`);
        }
        return 0;
      }
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') {
          this.setPositionals(args.slice(i + 1));
          return 0;
        }
        if (a === '-o' || a === '+o') {
          const opt = args[++i];
          if (opt) a === '-o' ? this.options.add(opt) : this.options.delete(opt);
          continue;
        }
        if (/^[-+][a-zA-Z]+$/.test(a)) {
          for (const f of a.slice(1)) a[0] === '-' ? this.options.add(f) : this.options.delete(f);
          continue;
        }
        // `set a b c`: positional parameters
        this.setPositionals(args.slice(i));
        return 0;
      }
      return 0;
    },
    command: async (args, _stdin, stdout, stderr) => {
      const flag = args[0];
      if (flag === '-v' || flag === '-V') {
        let code = 0;
        for (const name of args.slice(1)) {
          const kind = await this.describeCommand(name);
          if (!kind) {
            if (flag === '-V') stderr.write(`command: ${name}: not found\n`);
            code = 1;
          } else if (flag === '-v') {
            stdout.write(kind.type === 'file' ? `/usr/bin/${name}\n` : `${name}\n`);
          } else {
            stdout.write(kind.text + '\n');
          }
        }
        return code;
      }
      if (args.length === 0) return 0;
      // `command name args…`: run it, skipping shell functions.
      const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      const saved = this.functions;
      this.functions = new Map();
      try {
        return await this.executeLine(quoted, undefined, { stdout, stderr });
      } finally {
        this.functions = saved;
      }
    },
    type: async (args, _stdin, stdout, stderr) => {
      let code = 0;
      for (const name of args) {
        const kind = await this.describeCommand(name);
        if (kind) stdout.write(kind.text + '\n');
        else {
          stderr.write(`type: ${name}: not found\n`);
          code = 1;
        }
      }
      return code;
    },
  };

  private async describeCommand(name: string): Promise<{ type: 'alias' | 'function' | 'builtin' | 'file'; text: string } | null> {
    const alias = this.config.aliases?.get(name);
    if (alias !== undefined) return { type: 'alias', text: `${name} is aliased to \`${alias}'` };
    if (this.functions.has(name)) return { type: 'function', text: `${name} is a function` };
    if (this.config.builtins.has(name) || name in this.interpreterBuiltins || ['break', 'continue', 'return'].includes(name)) {
      return { type: 'builtin', text: `${name} is a shell builtin` };
    }
    if (this.config.registry.has(name)) return { type: 'file', text: `${name} is /usr/bin/${name}` };
    return null;
  }

  private positionals(): string[] {
    const count = parseInt(this.config.env['#'] ?? '0', 10) || 0;
    const out: string[] = [];
    for (let i = 1; i <= count; i++) out.push(this.config.env[String(i)] ?? '');
    return out;
  }

  private setPositionals(values: string[]): void {
    const old = parseInt(this.config.env['#'] ?? '0', 10) || 0;
    for (let i = values.length + 1; i <= old; i++) delete this.config.env[String(i)];
    values.forEach((v, i) => (this.config.env[String(i + 1)] = v));
    this.config.env['#'] = String(values.length);
    this.config.env['@'] = values.join(' ');
  }

  /**
   * The `read` builtin: `read [-r] [-p prompt] [-a] [name …]`. Reads one line, splits it on IFS
   * into the names (the last gets the rest of the line), or into REPLY with no names. Returns 1
   * at end of input. Without -r, a backslash escapes the next character and `\` + newline joins
   * lines.
   */
  private async builtinRead(args: string[], stdin: CommandInputStream | undefined, stderr: CommandOutputStream): Promise<number> {
    let raw = false;
    let prompt = '';
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-r') raw = true;
      else if (a === '-p') prompt = args[++i] ?? '';
      else if (/^-[rs]+$/.test(a)) raw = raw || a.includes('r');
      else if (a === '--') { names.push(...args.slice(i + 1)); break; }
      else if (a.startsWith('-') && a.length > 1) {
        stderr.write(`read: ${a}: unsupported option\n`);
        return 2;
      } else names.push(a);
    }
    if (prompt) stderr.write(prompt);
    if (!stdin) return 1;

    let line = '';
    let gotNewline = false;
    while (true) {
      let buffered = this.readLeftovers.get(stdin) ?? '';
      while (!buffered.includes('\n')) {
        const chunk = await stdin.read();
        if (chunk === null) break;
        buffered += chunk;
      }
      const nl = buffered.indexOf('\n');
      if (nl === -1) {
        this.readLeftovers.delete(stdin);
        line += buffered;
        break;
      }
      this.readLeftovers.set(stdin, buffered.slice(nl + 1));
      const piece = buffered.slice(0, nl);
      gotNewline = true;
      // Without -r, a trailing backslash continues onto the next line.
      if (!raw && /(^|[^\\])(\\\\)*\\$/.test(piece)) {
        line += piece.slice(0, -1);
        gotNewline = false;
        continue;
      }
      line += piece;
      break;
    }
    if (!gotNewline && line === '') {
      // At end of input the names are still assigned (empty), as in bash.
      if (names.length === 0) this.config.env['REPLY'] = '';
      for (const n of names) this.config.env[n] = '';
      return 1;
    }
    if (line.endsWith('\r')) line = line.slice(0, -1);

    const ifs = this.config.env['IFS'] ?? ' \t\n';
    const unescape = (t: string) => (raw ? t : t.replace(/\\(.)/g, '$1'));
    if (names.length === 0) {
      this.config.env['REPLY'] = unescape(line);
      return gotNewline ? 0 : 1;
    }
    const ws = [...ifs].filter((c) => c === ' ' || c === '\t' || c === '\n').join('');
    const isSep = (c: string) => ifs.includes(c);
    let rest = line;
    // Leading/trailing IFS whitespace is trimmed.
    if (ws) rest = rest.replace(new RegExp(`^[${escapeClass(ws)}]+|[${escapeClass(ws)}]+$`, 'g'), '');
    for (let n = 0; n < names.length; n++) {
      if (n === names.length - 1) {
        this.config.env[names[n]] = unescape(rest);
        break;
      }
      let j = 0;
      while (j < rest.length && !(isSep(rest[j]) && (raw || rest[j - 1] !== '\\'))) j++;
      this.config.env[names[n]] = unescape(rest.slice(0, j));
      // Skip one separator plus surrounding IFS whitespace.
      let k = j;
      while (k < rest.length && ws.includes(rest[k])) k++;
      if (k < rest.length && isSep(rest[k]) && !ws.includes(rest[k])) k++;
      while (k < rest.length && ws.includes(rest[k])) k++;
      rest = rest.slice(k);
    }
    return gotNewline ? 0 : 1;
  }

  private async executeIf(node: IfNode, inner?: StreamDefaults): Promise<number> {
    let exitCode = 0;

    for (const clause of node.clauses) {
      const condCode = await this.executeCompoundList(clause.condition, inner);
      if (condCode === 0) {
        exitCode = await this.executeCompoundList(clause.body, inner);
        this.lastExitCode = exitCode;
        return exitCode;
      }
    }

    if (node.elseBody) {
      exitCode = await this.executeCompoundList(node.elseBody, inner);
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeFor(node: ForNode, inner?: StreamDefaults): Promise<number> {
    const expandCtx = this.createExpandContext();
    let exitCode = 0;

    let values: string[];
    if (node.words !== null) {
      values = await expandWords(node.words, expandCtx);
    } else {
      // Use "$@"
      const atVal = this.config.env['@'] ?? '';
      values = atVal ? atVal.split(' ') : [];
    }

    for (const val of values) {
      this.config.env[node.variable] = val;
      try {
        exitCode = await this.executeCompoundList(node.body, inner);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          continue;
        }
        throw e;
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeWhile(node: WhileNode, inner?: StreamDefaults): Promise<number> {
    let exitCode = 0;

    while (true) {
      const condCode = await this.executeCompoundList(node.condition, inner);
      if (condCode !== 0) break;

      try {
        exitCode = await this.executeCompoundList(node.body, inner);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          continue;
        }
        throw e;
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeUntil(node: UntilNode, inner?: StreamDefaults): Promise<number> {
    let exitCode = 0;

    while (true) {
      const condCode = await this.executeCompoundList(node.condition, inner);
      if (condCode === 0) break;

      try {
        exitCode = await this.executeCompoundList(node.body, inner);
      } catch (e) {
        if (e instanceof BreakSignal) {
          if (e.levels > 1) throw new BreakSignal(e.levels - 1);
          break;
        }
        if (e instanceof ContinueSignal) {
          if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          continue;
        }
        throw e;
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeCase(node: CaseNode, inner?: StreamDefaults): Promise<number> {
    const expandCtx = this.createExpandContext();
    const wordValue = await expandWord(node.word, expandCtx);
    let exitCode = 0;

    for (const item of node.items) {
      for (const pattern of item.patterns) {
        const patternValue = await expandWord(pattern, expandCtx);
        if (globMatch(patternValue, wordValue)) {
          exitCode = await this.executeCompoundList(item.body, inner);
          this.lastExitCode = exitCode;
          return exitCode;
        }
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeFunctionDef(node: FunctionDefNode): Promise<number> {
    this.functions.set(node.name, node.body);
    return 0;
  }

  private async executeGroup(node: GroupNode, inner?: StreamDefaults): Promise<number> {
    const exitCode = await this.executeCompoundList(node.body, inner);
    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeCompoundList(lists: ListNode[], inner?: StreamDefaults): Promise<number> {
    let exitCode = 0;
    for (const list of lists) {
      exitCode = await this.executeList(list, undefined, inner);
    }
    return exitCode;
  }

  private async executeSimpleCommand(
    cmd: SimpleCommandNode,
    pipeStdin?: CommandInputStream,
    pipeStdout?: CommandOutputStream,
    terminalStdin?: TerminalStdin,
    pipeStderr?: CommandOutputStream,
    defaults?: StreamDefaults,
  ): Promise<number> {
    const scope = defaults?.scope;
    const cwd = scope?.cwd ?? this.config.getCwd();
    const expandCtx = this.createExpandContext(cwd);

    // Expand words
    const expandedArgs = await expandWords(cmd.words, expandCtx);
    if (expandedArgs.length === 0 && cmd.assignments.length > 0) {
      // Bare assignment -- set env vars
      for (const assign of cmd.assignments) {
        const value = await expandWord(assign.value, expandCtx);
        this.config.env[assign.name] = value;
      }
      return 0;
    }

    if (expandedArgs.length === 0) {
      return 0;
    }

    // Lifo command redirect: run the in-VM equivalent for a tool Lifo can't run
    // natively (e.g. `supabase …` → `npx tinbase …`). Skipped when the user has
    // their own alias for the name. The note is printed to stderr below (so
    // `2>/dev/null` suppresses it), once the streams are set up.
    const userAliased = this.config.aliases?.get(expandedArgs[0]) !== undefined;
    const redirect = userAliased ? null : commandRedirect(expandedArgs[0]);
    const effectiveArgs = redirect?.runAs
      ? [...redirect.runAs, ...expandedArgs.slice(1)]
      : expandedArgs;

    const [name, ...args] = effectiveArgs;

    // Check alias expansion
    const aliases = this.config.aliases;
    if (aliases) {
      const aliasValue = aliases.get(name);
      if (aliasValue !== undefined) {
        // Rebuild the command line with the alias expanded
        const expandedLine = aliasValue + (args.length > 0 ? ' ' + args.join(' ') : '');
        return this.executeLine(expandedLine);
      }
    }

    // Apply per-command assignments (temporary env)
    const savedEnv: Record<string, string | undefined> = {};
    for (const assign of cmd.assignments) {
      const value = await expandWord(assign.value, expandCtx);
      savedEnv[assign.name] = this.config.env[assign.name];
      this.config.env[assign.name] = value;
    }

    // Set up stdout/stderr: pipeline pipe > per-execution defaults > shared
    // config override > terminal. Per-execution defaults exist so concurrent
    // shell.execute() calls don't fight over the shared config streams.
    let stdout: CommandOutputStream = pipeStdout ?? defaults?.stdout ?? this.config.defaultStdout ?? this.terminalStream();
    let stderr: CommandOutputStream = pipeStderr ?? defaults?.stderr ?? this.config.defaultStderr ?? this.terminalStream();
    let stdin: CommandInputStream | undefined = pipeStdin ?? defaults?.stdin;

    // Apply redirections (left to right)
    ({ stdout, stderr, stdin } = await this.applyRedirections(cmd.redirections, { stdout, stderr, stdin }, cwd));

    // If no stdin from pipe or redirect, fall back to terminal stdin
    if (!stdin && terminalStdin) {
      stdin = terminalStdin;
    }

    // Note the redirect now that stderr (with any redirections) is set up.
    if (redirect?.runAs) stderr.write(redirect.message + '\n');

    let exitCode: number;

    try {
      // Check for break/continue/return builtins
      if (name === 'break') {
        const levels = args[0] ? parseInt(args[0], 10) : 1;
        throw new BreakSignal(levels);
      }
      if (name === 'continue') {
        const levels = args[0] ? parseInt(args[0], 10) : 1;
        throw new ContinueSignal(levels);
      }
      if (name === 'return') {
        const code = args[0] ? parseInt(args[0], 10) : this.lastExitCode;
        throw new ReturnSignal(code);
      }
      if (name === 'exit' && (this.subshellDepth > 0 || this.scriptDepth > 0)) {
        throw new ExitSignal(args[0] ? parseInt(args[0], 10) & 255 : this.lastExitCode);
      }

      // Check functions
      const funcBody = this.functions.get(name);
      const interpBuiltin = funcBody ? undefined : this.interpreterBuiltins[name];
      if (interpBuiltin) {
        exitCode = await interpBuiltin(args, stdin, stdout, stderr);
      } else if (funcBody) {
        // The function's body writes where this call does: its pipe, redirect or capture.
        exitCode = await this.executeFunction(funcBody, args, { ...defaults, stdout, stderr });
      } else {
        // Check builtins
        const builtin = this.config.builtins.get(name);
        if (builtin) {
          if (scope) {
            // Builtins (cd, pwd, read, …) use the shell's cwd: lend them the scope's, and keep
            // whatever a `cd` made of it.
            const shellCwd = this.config.getCwd();
            this.config.setCwd(scope.cwd);
            try {
              exitCode = await builtin(args, stdout, stderr, stdin);
            } finally {
              scope.cwd = this.config.getCwd();
              this.config.setCwd(shellCwd);
            }
          } else {
            exitCode = await builtin(args, stdout, stderr, stdin);
          }
        } else {
          // Check registry
          const command = await this.config.registry.resolve(name);
          if (!command) {
            // To stderr (not the terminal directly) so `2>&1` / `2>/dev/null`
            // apply to it, as in bash.
            stderr.write(`${name}: command not found\n`);
            // Note-only redirects (no in-VM equivalent to run, e.g. docker).
            const note = commandRedirect(name);
            if (note) stderr.write(note.message + '\n');
            exitCode = 127;
          } else {
            // Only register if NOT part of a background job (which has its own registration)
            const shouldRegister = !this.config.isBackgroundContext;
            let pid: number | undefined;
            let abortController: AbortController;

            // Get shell signal (may be from background job's abortController).
            // An explicitly-threaded `defaults.abortSignal` wins: it's how a
            // background job hands its own signal down without racing the
            // synchronous restore of config.getAbortSignal.
            const shellSignal = defaults?.abortSignal ?? this.config.getAbortSignal?.() ?? new AbortController().signal;

            if (shouldRegister) {
              // Register process so it's visible in ps from other shells
              abortController = new AbortController();

              // Combine shell abort signal with process abort signal
              if (shellSignal) {
                shellSignal.addEventListener('abort', () => abortController.abort(), { once: true });
              }
            } else {
              // Background context: use shell's abort controller (which is the background job's controller)
              abortController = new AbortController();
              shellSignal.addEventListener('abort', () => abortController.abort(), { once: true });
            }

            const ctx: CommandContext = {
              args,
              env: { ...this.config.env },
              cwd,
              vfs: this.config.vfs,
              stdout,
              stderr,
              signal: abortController.signal,
              stdin,
              setRawMode: terminalStdin
                ? (v: boolean) => { terminalStdin.rawMode = v; }
                : undefined,
              executeCapture: (captureInput, captureOpts) => this.executeCapture(captureInput, captureOpts),
              executeCaptureResult: (captureInput, captureOpts) => this.executeCaptureResult(captureInput, captureOpts),
            };

            // Register process BEFORE executing so ps can see itself
            let commandPromise: Promise<number>;

            if (shouldRegister) {
              // Create a promise that will be resolved when command completes
              let resolvePromise: (code: number) => void;
              let rejectPromise: (err: any) => void;
              const registeredPromise = new Promise<number>((resolve, reject) => {
                resolvePromise = resolve;
                rejectPromise = reject;
              });

              // Register the process FIRST
              pid = this.config.processRegistry.spawn({
                command: name,
                args: [name, ...args],
                cwd,
                env: { ...this.config.env },
                isForeground: true,
                promise: registeredPromise,
                abortController,
              });

              // Now execute the command and wire it to the registered promise
              commandPromise = command(ctx).then(
                (code) => {
                  resolvePromise!(code);
                  return code;
                },
                (err) => {
                  const code = (err instanceof Error && err.name === 'AbortError') ? 130 : 1;
                  rejectPromise!(err);
                  return code;
                }
              );
            } else {
              // Background context - just execute
              commandPromise = command(ctx);
            }

            try {
              exitCode = await commandPromise;
            } catch (e) {
              if (e instanceof Error && e.name === 'AbortError') {
                exitCode = 130;
              } else {
                stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`);
                exitCode = 1;
              }
            } finally {
              if (shouldRegister && pid !== undefined) {
                // Wait for microtasks (status update) to complete before reaping
                await Promise.resolve();
                this.config.processRegistry.reap(pid);
              }
            }
          }
        }
      }
    } finally {
      // Restore env from per-command assignments
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) {
          delete this.config.env[key];
        } else {
          this.config.env[key] = val;
        }
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeFunction(body: CompoundCommandNode, args: string[], streams?: StreamDefaults): Promise<number> {
    // Save positional parameters
    const savedPositionals: Record<string, string | undefined> = {};
    const keysToSave = ['@', '#'];
    for (let i = 0; i <= 9; i++) keysToSave.push(String(i));
    // Save extra positional params
    for (let i = 10; i < args.length + 10; i++) keysToSave.push(String(i));

    for (const key of keysToSave) {
      savedPositionals[key] = this.config.env[key];
    }

    // Set new positional parameters
    this.config.env['#'] = String(args.length);
    this.config.env['@'] = args.join(' ');
    for (let i = 0; i < args.length; i++) {
      this.config.env[String(i + 1)] = args[i];
    }

    let exitCode: number;
    const locals = new Map<string, string | undefined>();
    this.localScopes.push(locals);
    try {
      exitCode = await this.executeCommand(body, undefined, undefined, undefined, undefined, streams);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.exitCode;
      } else {
        throw e;
      }
    } finally {
      this.localScopes.pop();
      for (const [key, val] of locals) {
        if (val === undefined) delete this.config.env[key];
        else this.config.env[key] = val;
      }
      // Restore positional parameters
      for (const [key, val] of Object.entries(savedPositionals)) {
        if (val === undefined) {
          delete this.config.env[key];
        } else {
          this.config.env[key] = val;
        }
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  async executeCapture(input: string, opts?: { cwd?: string }): Promise<string> {
    return (await this.executeCaptureResult(input, opts)).stdout;
  }

  /**
   * Like executeCapture but also reports the final exit code, so callers that
   * need to distinguish success from failure can. child_process relies on this
   * to emit an ENOENT `error` for a missing command (exit 127) — matching Node,
   * so libraries like fb-watchman detect "watchman not installed" and fall back
   * instead of hanging on a phantom child that never errors.
   */
  async executeCaptureResult(input: string, opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string; code: number }> {
    let captured = '';
    let capturedErr = '';
    const stdout: CommandOutputStream = {
      write: (text: string) => { captured += text; },
    };
    // Capture stderr per-execution too. Without this it fell through to the
    // SHARED default (the terminal), so tools spawned inside a running CLI —
    // Metro's `find`, watchman probes, nested npm installs — sprayed their
    // stderr into the user's interactive terminal (and in Node semantics,
    // execFile pipes both streams to the caller, not the tty).
    const stderr: CommandOutputStream = {
      write: (text: string) => { capturedErr += text; },
    };

    const tokens = lex(input);
    const script = parse(tokens);

    // Optionally run in a different cwd (e.g. child_process spawn with {cwd}),
    // restoring afterward so the caller's cwd is unaffected.
    const prevCwd = opts?.cwd !== undefined ? this.config.getCwd() : undefined;
    if (opts?.cwd !== undefined) this.config.setCwd(opts.cwd);
    let code = 0;
    try {
      // Execute with captured stdout/stderr via per-execution defaults —
      // pipes, && / ||, and compound commands all route into the capture.
      this.scriptDepth++;
      code = await this.executeScript(script, undefined, { stdout, stderr });
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
      code = e.exitCode;
    } finally {
      this.scriptDepth--;
      if (prevCwd !== undefined) this.config.setCwd(prevCwd);
    }

    return { stdout: captured, stderr: capturedErr, code };
  }

  private createExpandContext(cwd: string = this.config.getCwd()): ExpandContext {
    return {
      env: this.config.env,
      lastExitCode: this.lastExitCode,
      cwd,
      vfs: this.config.vfs,
      executeCapture: (input) => this.executeCapture(input),
      pid: this.pid,
      lastBackgroundPid: this.lastBackgroundPid,
    };
  }

  private createFileWriter(path: string): CommandOutputStream {
    // Append per write — the redirect setup already truncated the file once.
    // Truncating on EVERY write kept only a command's final chunk (and lost
    // stdout entirely under `> f 2>&1`, where both streams share this writer).
    return {
      write: (text: string) => {
        this.config.vfs.appendFile(path, text);
      },
    };
  }

  private createFileAppender(path: string): CommandOutputStream {
    return {
      write: (text: string) => {
        this.config.vfs.appendFile(path, text);
      },
    };
  }

  private createStringReader(content: string): CommandInputStream {
    let consumed = false;
    return {
      read: async () => {
        if (consumed) return null;
        consumed = true;
        return content;
      },
      readAll: async () => {
        if (consumed) return '';
        consumed = true;
        return content;
      },
    };
  }

  private createFileReader(path: string): CommandInputStream {
    const content = this.config.vfs.readFileString(path);
    let consumed = false;
    return {
      read: async () => {
        if (consumed) return null;
        consumed = true;
        return content;
      },
      readAll: async () => content,
    };
  }
}

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}
