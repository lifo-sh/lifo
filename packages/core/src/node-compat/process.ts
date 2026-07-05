import type { CommandOutputStream } from '../commands/types.js';

export class ProcessExitError extends Error {
  exitCode: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
    this.exitCode = code;
  }
}

export interface ProcessOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
}

export function createProcess(opts: ProcessOptions) {
  const startTime = Date.now();
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  const proc = {
    argv: ['/usr/bin/node', ...opts.argv],
    argv0: 'node',
    env: { ...opts.env },
    cwd: () => opts.cwd,
    chdir: (_dir: string) => { throw new Error('process.chdir() is not supported in Lifo'); },
    exit: (code = 0) => {
      if (code !== 0) {
        opts.stderr.write(`[process.exit] code=${code}\n`);
      }
      throw new ProcessExitError(code);
    },
    stdout: {
      write: (data: string) => { opts.stdout.write(data); return true; },
      isTTY: false,
      fd: 1,
      bytesWritten: 0,
      columns: 80,
      on: () => {},
      once: () => {},
    },
    stderr: {
      write: (data: string) => { opts.stderr.write(data); return true; },
      isTTY: false,
      fd: 2,
      bytesWritten: 0,
      columns: 80,
      on: () => {},
      once: () => {},
    },
    stdin: {
      isTTY: false,
      fd: 0,
      on: () => {},
      once: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      read: () => null,
    },
    platform: 'linux' as string,
    arch: 'x64' as string,
    version: 'v22.14.0',
    versions: {
      node: '22.14.0',
      lifo: '0.1.0',
    },
    pid: 1,
    ppid: 0,
    title: 'node',
    execPath: '/usr/bin/node',
    hrtime: Object.assign(
      (prev?: [number, number]): [number, number] => {
        const now = performance.now();
        const sec = Math.floor(now / 1000);
        const nano = Math.floor((now % 1000) * 1e6);
        if (prev) {
          let ds = sec - prev[0];
          let dn = nano - prev[1];
          if (dn < 0) { ds--; dn += 1e9; }
          return [ds, dn];
        }
        return [sec, nano];
      },
      {
        bigint: (): bigint => BigInt(Math.floor(performance.now() * 1e6)),
      },
    ),
    nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => fn(...args));
    },
    memoryUsage: () => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      return {
        rss: m?.usedJSHeapSize ?? 0,
        heapTotal: m?.totalJSHeapSize ?? 0,
        heapUsed: m?.usedJSHeapSize ?? 0,
        external: 0,
        arrayBuffers: 0,
      };
    },
    uptime: () => (Date.now() - startTime) / 1000,
    release: { name: 'node' },
    config: {},
    emitWarning: (msg: string) => { opts.stderr.write(`Warning: ${msg}\n`); },
    // POSIX identity stubs (needed by many npm packages)
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    umask: (mask?: number) => mask ?? 0o22,
    // process.binding() stub — low-level Node.js internal, used by execa/errname etc.
    binding: (name: string) => {
      if (name === 'uv') {
        return {
          errname: (code: number) => `UV_UNKNOWN_${code}`,
          UV_EOF: -4095,
        };
      }
      if (name === 'natives') return {};
      if (name === 'constants') return { os: {}, fs: {}, crypto: {} };
      return {};
    },
    // EventEmitter-like methods (many packages check for process.on('exit'))
    on: (event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return proc;
    },
    addListener: (event: string, fn: (...args: unknown[]) => void) => {
      return proc.on(event, fn);
    },
    once: (event: string, fn: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        proc.removeListener(event, wrapped);
        fn(...args);
      };
      return proc.on(event, wrapped);
    },
    off: (event: string, fn: (...args: unknown[]) => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
      return proc;
    },
    removeListener: (event: string, fn: (...args: unknown[]) => void) => proc.off(event, fn),
    removeAllListeners: (event?: string) => {
      if (event) delete listeners[event];
      else Object.keys(listeners).forEach((k) => delete listeners[k]);
      return proc;
    },
    listeners: (event: string) => listeners[event] ? [...listeners[event]] : [],
    emit: (event: string, ...args: unknown[]) => {
      const fns = listeners[event];
      if (!fns || fns.length === 0) return false;
      for (const fn of [...fns]) fn(...args);
      return true;
    },
    listenerCount: (event: string) => listeners[event]?.length ?? 0,
    setMaxListeners: () => proc,
    getMaxListeners: () => 10,
    prependListener: (event: string, fn: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].unshift(fn);
      return proc;
    },
    rawListeners: (event: string) => listeners[event] ? [...listeners[event]] : [],
    eventNames: () => Object.keys(listeners),
    // Feature detection flags
    allowedNodeEnvironmentFlags: new Set<string>(),
    features: { inspector: false, debug: false, uv: false, tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false },
  };

  return proc;
}
