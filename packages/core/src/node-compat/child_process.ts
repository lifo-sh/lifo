import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';
import { Readable, Writable } from './stream.js';
import { resolve } from '../utils/path.js';

type ExecuteCapture = (input: string, opts?: { cwd?: string }) => Promise<string>;
type ExecuteCaptureResult = (input: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Quote an argv token for the shell command line executeCapture parses. */
function quoteArg(a: string): string {
  if (a === '') return "''";
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(a)) return a;
  return "'" + a.replace(/'/g, `'\\''`) + "'";
}

/** A readable-ish stream stub for a child's stdout/stderr. */
/**
 * Node's ChildProcess: what spawn/exec/execFile return, and a class code can check against or
 * construct (execa builds one for a command that failed to start). Its stdout and stderr are
 * Readables the command's output is pushed into once it has run; stdin takes writes and
 * discards them, since the command has already been started with no input.
 */
export class ChildProcess extends (EventEmitter as unknown as new () => EventEmitter) {
  pid: number | undefined = undefined;
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  stdio: Array<Readable | Writable | null> = [null, null, null];
  killed = false;
  connected = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  spawnfile = '';
  spawnargs: string[] = [];
  kill(_signal?: string | number): boolean { return true; }
  ref(): this { return this; }
  unref(): this { return this; }
}

function makeChild(): ChildProcess {
  const child = new ChildProcess();
  child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  child.stdout = new Readable();
  child.stderr = new Readable();
  child.stdio = [child.stdin, child.stdout, child.stderr];
  child.pid = 1;
  return child;
}

/**
 * Hands a finished command's result to its child object in Node's order: the output into
 * stdout/stderr, 'exit', then 'close' once both streams have closed. A stream nobody reads is
 * drained, as Node does, so 'close' still comes.
 */
function finishChild(child: ChildProcess, out: string, errOut: string, code: number | null, signal: string | null): void {
  const streams = [child.stdout!, child.stderr!];
  let open = streams.length;
  const closed = () => {
    if (--open === 0) child.emit('close', code, signal);
  };
  for (const stream of streams) stream.once('close', closed);
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('exit', code, signal);
  // The command is gone, so is its end of stdin (Node destroys the pipe; execa waits for it).
  if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
  if (out) child.stdout!.push(Buffer.from(out));
  child.stdout!.push(null);
  if (errOut) child.stderr!.push(Buffer.from(errOut));
  child.stderr!.push(null);
  queueMicrotask(() => {
    for (const stream of streams) {
      if (stream.listenerCount('data') === 0 && stream.listenerCount('readable') === 0) stream.resume();
    }
  });
}

/** Queues a command line to run, on the program's terminal, once the program has ended. */
type RunAfterExit = (line: string, cwd?: string) => void;

/** Options child_process.fork() passes on (Node's names). */
export interface ForkOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: unknown;
  silent?: boolean;
  execArgv?: string[];
}
/** Starts a node run in this box with an IPC channel to it (see commands/system/node.ts). */
export type ForkNode = (modulePath: string, args: string[], options: ForkOptions) => unknown;

/** What the node runner lends child_process beyond running command lines. */
export interface ChildProcessHooks {
  runAfterExit?: RunAfterExit;
  forkNode?: ForkNode;
  /** The run's process.env, for questions answered from it (see knownAnswer). */
  env?: Record<string, string | undefined>;
  /** The run's working directory now (it moves with process.chdir): children start there. */
  cwd?: () => string;
}

/**
 * Read-only questions a box answers without running a command, so a synchronous call that
 * only asks one works: a package manager's registry (Next.js asks `npm config get registry`
 * before it downloads its WebAssembly compiler). The registry is the one the box's npm uses.
 */
function knownAnswer(line: string, env: Record<string, string | undefined>): string | null {
  if (/^(?:npm|pnpm|yarn)\s+config\s+get\s+(?:registry|npmRegistryServer)(?:\s|$)/.test(line.trim())) {
    // Same default as the npm command (commands/system/npm.ts).
    return `${(env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/?$/, '/')}\n`;
  }
  return null;
}

export function createChildProcess(
  executeCapture?: ExecuteCapture,
  executeCaptureResult?: ExecuteCaptureResult,
  hooks: ChildProcessHooks = {},
) {
  const { runAfterExit, forkNode } = hooks;
  // Where a child starts: its own cwd option (relative to the program's), else the program's.
  const childCwd = (cwd: unknown): string | undefined => {
    const base = hooks.cwd?.();
    if (typeof cwd !== 'string' || !cwd) return base;
    return base ? resolve(base, cwd) : cwd;
  };
  // Run a shell command line and deliver the result to a child object: stream
  // stdout, fire the callback, emit close/exit. This is the bridge that lets
  // in-VM tools shell out to other commands (e.g. create-expo-app → `npm pack`).
  function drive(
    child: ReturnType<typeof makeChild>,
    cmdLine: string,
    cwd: string | undefined,
    cb?: (err: Error | null, stdout: string, stderr: string) => void,
  ): void {
    // 'spawn' means the command started, so a command that doesn't exist never gets one (only
    // 'error', as in Node: execa waits for 'exit' forever after a 'spawn'). A missing command
    // is known within the same task; one still running after that has started.
    let spawned = false;
    let settled = false;
    const emitSpawn = () => {
      if (spawned) return;
      spawned = true;
      child.emit('spawn');
    };
    const spawnTimer = setTimeout(() => { if (!settled) emitSpawn(); }, 0);
    queueMicrotask(async () => {
      let out = '';
      let errOut = '';
      let err: Error | null = null;
      let code = 0;
      try {
        if (executeCaptureResult) {
          const at = childCwd(cwd);
          const r = await executeCaptureResult(cmdLine, at ? { cwd: at } : undefined);
          out = r.stdout; errOut = r.stderr; code = r.code;
        } else if (executeCapture) {
          const at = childCwd(cwd);
          out = await executeCapture(cmdLine, at ? { cwd: at } : undefined);
        } else {
          err = new Error('child_process requires a shell executor');
        }
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
      // Shell exit 127 = command not found. Surface it as ENOENT like Node, so
      // callers that probe for an optional binary detect its absence instead of
      // treating an empty-stdout "success" as real. Notably fb-watchman spawns
      // `watchman get-sockname`; without this it saw exit 0 + empty output and
      // hung connecting to a phantom socket, stalling Metro's first bundle
      // (spurious 504 on `expo start --web`). It now falls back to the node
      // file crawler and bundles normally.
      if (!err && code === 127) {
        const cmd0 = cmdLine.trim().split(/\s+/)[0];
        err = Object.assign(new Error(`spawn ${cmd0} ENOENT`), {
          code: 'ENOENT', errno: -2, syscall: `spawn ${cmd0}`, path: cmd0,
        });
      }
      const isEnoent = !!err && (err as { code?: string }).code === 'ENOENT';
      settled = true;
      clearTimeout(spawnTimer);
      if (isEnoent) {
        if (cb) cb(err, out, errOut || err!.message);
        // Node emits 'error' (and no 'exit') when a binary never launches. Only
        // emit it if something is listening — an unhandled 'error' would throw
        // and crash the VM; tools that spawn optional helpers (e.g. expo probing
        // xcodebuild/osascript) without an error handler instead see a nonzero
        // close, which they treat as "not available" rather than crashing.
        if (child.listenerCount('error') > 0) {
          // A process that never started has no pipes: all three close (execa waits on stdin).
          child.stdin?.destroy();
          child.stdout!.push(null);
          child.stderr!.push(null);
          child.emit('error', err);
          child.emit('close', null, null);
        } else {
          finishChild(child, '', errOut || err!.message, 127, null);
        }
        return;
      }
      // Readable streams end with 'close' after 'end': Metro's node file crawler (findNative)
      // resolves its crawl only from `child.stdout.on('close')`.
      const finish = () => {
        if (cb) cb(err, out, errOut || (err ? err.message : ''));
        finishChild(child, out, errOut || (err ? err.message : ''), err ? 1 : code, null);
      };
      // A command that finished within its first task: 'spawn' now, the rest a task later, so
      // code that awaits 'spawn' and then 'exit' sees both, as with a real process.
      if (spawned) {
        finish();
      } else {
        emitSpawn();
        setTimeout(finish, 0);
      }
    });
  }

  function exec(
    cmd: string,
    optionsOrCb?: Record<string, unknown> | ((err: Error | null, stdout: string, stderr: string) => void),
    cb?: (err: Error | null, stdout: string, stderr: string) => void,
  ): EventEmitter {
    const options = (typeof optionsOrCb === 'object' ? optionsOrCb : {}) as { cwd?: string };
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    const child = makeChild();
    drive(child, cmd, options.cwd, callback);
    return child;
  }

  function execFile(
    file: string,
    argsOrOpts?: string[] | Record<string, unknown> | ((e: Error | null, o: string, s: string) => void),
    optsOrCb?: Record<string, unknown> | ((e: Error | null, o: string, s: string) => void),
    cb?: (e: Error | null, o: string, s: string) => void,
  ): EventEmitter {
    const args = Array.isArray(argsOrOpts) ? argsOrOpts : [];
    const rest = Array.isArray(argsOrOpts) ? optsOrCb : argsOrOpts;
    const options = (typeof rest === 'object' ? rest : {}) as { cwd?: string };
    const callback = typeof rest === 'function' ? rest : typeof optsOrCb === 'function' ? optsOrCb : cb;
    const child = makeChild();
    drive(child, [file, ...args].map(quoteArg).join(' '), options.cwd, callback);
    return child;
  }

  function spawn(
    command: string,
    argsOrOpts?: string[] | Record<string, unknown>,
    maybeOpts?: Record<string, unknown>,
  ): EventEmitter {
    const args = Array.isArray(argsOrOpts) ? argsOrOpts : [];
    const options = ((Array.isArray(argsOrOpts) ? maybeOpts : argsOrOpts) || {}) as { cwd?: string };
    const child = makeChild();
    child.spawnfile = command;
    child.spawnargs = [command, ...args];
    if (!executeCapture) {
      // No shell executor (e.g. a bare test env): benign exit-0 with empty output
      // so tools spawning optional helpers (a browser opener, etc.) don't crash.
      queueMicrotask(() => {
        child.emit('spawn');
        finishChild(child, '', '', 0, null);
      });
      return child;
    }
    drive(child, [command, ...args].map(quoteArg).join(' '), options.cwd);
    return child;
  }

  // spawnSync, execSync and execFileSync can't block in a box: the program, the shell and every
  // command share one JavaScript thread, so nothing else runs while a program waits synchronously.
  //
  // When the child's output goes straight to the terminal (stdio 'inherit'), the program never
  // sees it, only the exit status. That is how CLIs "install and start now" (create-vite runs
  // `npm install` then `npm run dev`). Such a child is queued to run on the terminal once the
  // program ends (the node command runs them in order, stopping at the first failure), and the
  // call reports success. Everything else fails the way Node fails to spawn, with an error
  // carrying a code that says what didn't run.
  function syncSpawnError(syscall: string, command: string, args: string[], cwd: unknown) {
    const line = [command, ...args].join(' ');
    const where = typeof cwd === 'string' && cwd ? ` in ${cwd}` : '';
    const err = new Error(
      `[lifo] ${syscall} can't run "${line}": a box can't pause a program while another command runs. Run it yourself${where}.`,
    ) as Error & Record<string, unknown>;
    Object.assign(err, { code: 'ENOSYS', errno: -38, syscall: `${syscall} ${command}`, path: command, spawnargs: args });
    err.stack = `Error: ${err.message}`; // the frames are Lifo's, not the program's
    return err;
  }

  type SyncOptions = { cwd?: string; encoding?: string; stdio?: unknown; input?: unknown; shell?: unknown; env?: Record<string, string | undefined> } | undefined;
  const splitArgs = (args?: unknown, options?: unknown): [string[], SyncOptions] =>
    Array.isArray(args) ? [args.map(String), options as SyncOptions] : [[], args as SyncOptions];

  /** stdio 'inherit', or stdout and stderr each 'inherit', their fd, or a stream with that fd. */
  const outputInherited = (stdio: unknown): boolean => {
    if (stdio === 'inherit') return true;
    if (!Array.isArray(stdio)) return false;
    const inherits = (v: unknown, fd: number) =>
      v === 'inherit' || v === fd || (!!v && typeof v === 'object' && (v as { fd?: unknown }).fd === fd);
    return inherits(stdio[1], 1) && inherits(stdio[2], 2);
  };

  /** Queue the child to run after the program, if it can be: true when queued. */
  const runLater = (line: string, opts: SyncOptions): boolean => {
    if (!runAfterExit || !outputInherited(opts?.stdio) || opts?.input !== undefined) return false;
    runAfterExit(line, childCwd(opts?.cwd));
    return true;
  };

  const asText = (text: string, encoding?: string): string | Buffer =>
    encoding && encoding !== 'buffer' ? text : Buffer.from(text);
  const answer = (line: string, opts: SyncOptions) =>
    knownAnswer(line, opts?.env ?? hooks.env ?? {});

  function spawnSync(command: string, args?: unknown, options?: unknown) {
    const [argv, opts] = splitArgs(args, options);
    const line = opts?.shell ? [command, ...argv].join(' ') : [command, ...argv].map(quoteArg).join(' ');
    if (runLater(line, opts)) {
      return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: 0, signal: null };
    }
    const known = answer(line, opts);
    if (known !== null) {
      const out = asText(known, opts?.encoding);
      const none = asText('', opts?.encoding);
      return { pid: 0, output: [null, out, none], stdout: out, stderr: none, status: 0, signal: null };
    }
    const empty = asText('', opts?.encoding);
    return {
      pid: 0,
      output: [null, empty, empty],
      stdout: empty,
      stderr: empty,
      status: null,
      signal: null,
      error: syncSpawnError('spawnSync', command, argv, opts?.cwd),
    };
  }

  function execFileSync(file: string, args?: unknown, options?: unknown): string | Buffer | null {
    const [argv, opts] = splitArgs(args, options);
    const line = [file, ...argv].map(quoteArg).join(' ');
    if (runLater(line, opts)) return null;
    const known = answer(line, opts);
    if (known !== null) return asText(known, opts?.encoding);
    throw syncSpawnError('execFileSync', file, argv, opts?.cwd);
  }

  function execSync(command: string, options?: SyncOptions): string | Buffer | null {
    if (runLater(String(command), options)) return null;
    const known = answer(String(command), options);
    if (known !== null) return asText(known, options?.encoding);
    throw syncSpawnError('execSync', String(command), [], options?.cwd);
  }

  function fork(modulePath: string, args?: unknown, options?: unknown): unknown {
    if (!forkNode) throw new Error('child_process.fork() is not supported in Lifo');
    const argv = Array.isArray(args) ? args.map(String) : [];
    const opts = ((Array.isArray(args) ? options : args) ?? {}) as ForkOptions;
    return forkNode(String(modulePath), argv, opts);
  }

  return { exec, execFile, spawn, spawnSync, execSync, execFileSync, fork, ChildProcess };
}
