import { EventEmitter } from './events.js';

type ExecuteCapture = (input: string) => Promise<string>;

export function createChildProcess(executeCapture?: ExecuteCapture) {
  function exec(
    cmd: string,
    optionsOrCb?: Record<string, unknown> | ((err: Error | null, stdout: string, stderr: string) => void),
    cb?: (err: Error | null, stdout: string, stderr: string) => void,
  ): EventEmitter {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    const child = new EventEmitter();

    if (!executeCapture) {
      queueMicrotask(() => {
        const err = new Error('child_process.exec() requires shell interpreter');
        if (callback) callback(err, '', '');
        child.emit('error', err);
      });
      return child;
    }

    const run = executeCapture;
    queueMicrotask(async () => {
      try {
        const output = await run(cmd);
        if (callback) callback(null, output, '');
        child.emit('close', 0);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (callback) callback(err, '', err.message);
        child.emit('close', 1);
      }
    });

    return child;
  }

  function execSync(): never {
    throw new Error('child_process.execSync() is not supported in Lifo');
  }

  function spawn(): EventEmitter {
    // No real subprocesses in the VM. Rather than throw (which crashes tools
    // that spawn optional helpers — e.g. `open` launching a browser, which is
    // meaningless here since the preview iframe IS the browser), return a
    // benign child that immediately exits 0 with empty output streams.
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const mkStream = () => {
      const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
      s.pipe = (dest: unknown) => dest;
      s.setEncoding = () => s;
      s.destroy = () => s;
      s.read = () => null;
      s.resume = () => s;
      s.pause = () => s;
      return s;
    };
    const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stdin.write = () => true;
    stdin.end = () => {};
    child.stdout = mkStream();
    child.stderr = mkStream();
    child.stdin = stdin;
    child.pid = 0;
    child.kill = () => true;
    child.unref = () => child;
    child.ref = () => child;
    queueMicrotask(() => {
      (child.stdout as EventEmitter).emit('end');
      (child.stderr as EventEmitter).emit('end');
      child.emit('spawn');
      child.emit('close', 0, null);
      child.emit('exit', 0, null);
    });
    return child;
  }

  function fork(): never {
    throw new Error('child_process.fork() is not supported in Lifo');
  }

  return { exec, execSync, spawn, fork };
}
