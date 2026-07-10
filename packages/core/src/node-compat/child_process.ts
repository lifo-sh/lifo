import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';

type ExecuteCapture = (input: string, opts?: { cwd?: string }) => Promise<string>;
type ExecuteCaptureResult = (input: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Quote an argv token for the shell command line executeCapture parses. */
function quoteArg(a: string): string {
  if (a === '') return "''";
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(a)) return a;
  return "'" + a.replace(/'/g, `'\\''`) + "'";
}

/** A readable-ish stream stub for a child's stdout/stderr. */
function makeStream() {
  const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
  s.pipe = (dest: unknown) => dest;
  s.setEncoding = () => s;
  s.destroy = () => s;
  s.read = () => null;
  s.resume = () => s;
  s.pause = () => s;
  return s;
}

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter;
  } & Record<string, unknown>;
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.write = () => true;
  stdin.end = () => {};
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.stdin = stdin;
  child.pid = 1;
  child.kill = () => true;
  child.unref = () => child;
  child.ref = () => child;
  return child;
}

export function createChildProcess(executeCapture?: ExecuteCapture, executeCaptureResult?: ExecuteCaptureResult) {
  // Run a shell command line and deliver the result to a child object: stream
  // stdout, fire the callback, emit close/exit. This is the bridge that lets
  // in-VM tools shell out to other commands (e.g. create-expo-app → `npm pack`).
  function drive(
    child: ReturnType<typeof makeChild>,
    cmdLine: string,
    cwd: string | undefined,
    cb?: (err: Error | null, stdout: string, stderr: string) => void,
  ): void {
    queueMicrotask(async () => {
      let out = '';
      let errOut = '';
      let err: Error | null = null;
      let code = 0;
      try {
        if (executeCaptureResult) {
          const r = await executeCaptureResult(cmdLine, cwd ? { cwd } : undefined);
          out = r.stdout; errOut = r.stderr; code = r.code;
        } else if (executeCapture) {
          out = await executeCapture(cmdLine, cwd ? { cwd } : undefined);
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
      if (out) child.stdout.emit('data', Buffer.from(out));
      child.stdout.emit('end');
      // Node readable streams emit 'close' after 'end'. Some consumers wait on
      // it exclusively — notably Metro's node file crawler (findNative) resolves
      // its crawl only from `child.stdout.on('close')`; without it the crawl
      // promise never settles and the first bundle hangs (the create-expo-app
      // `expo start --web` 504).
      child.stdout.emit('close');
      if (errOut) child.stderr.emit('data', Buffer.from(errOut));
      else if (err) child.stderr.emit('data', Buffer.from(err.message));
      child.stderr.emit('end');
      child.stderr.emit('close');
      if (cb) cb(err, out, errOut || (err ? err.message : ''));
      if (isEnoent) {
        // Node emits 'error' (and no 'exit') when a binary never launches. Only
        // emit it if something is listening — an unhandled 'error' would throw
        // and crash the VM; tools that spawn optional helpers (e.g. expo probing
        // xcodebuild/osascript) without an error handler instead see a nonzero
        // close, which they treat as "not available" rather than crashing.
        if (child.listenerCount('error') > 0) {
          child.emit('error', err);
          child.emit('close', null, null);
        } else {
          child.emit('close', 127, null);
          child.emit('exit', 127, null);
        }
        return;
      }
      const exitCode = err ? 1 : code;
      child.emit('close', exitCode, null);
      child.emit('exit', exitCode, null);
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
    queueMicrotask(() => child.emit('spawn'));
    if (!executeCapture) {
      // No shell executor (e.g. a bare test env): benign exit-0 with empty output
      // so tools spawning optional helpers (a browser opener, etc.) don't crash.
      queueMicrotask(() => {
        child.stdout.emit('end');
        child.stdout.emit('close');
        child.stderr.emit('end');
        child.stderr.emit('close');
        child.emit('close', 0, null);
        child.emit('exit', 0, null);
      });
      return child;
    }
    drive(child, [command, ...args].map(quoteArg).join(' '), options.cwd);
    return child;
  }

  function execSync(): never {
    throw new Error('child_process.execSync() is not supported in Lifo (use exec/spawn)');
  }

  function fork(): never {
    throw new Error('child_process.fork() is not supported in Lifo');
  }

  return { exec, execFile, spawn, execSync, fork };
}
