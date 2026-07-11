import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
import { Buffer } from './buffer.js';

/**
 * Build a Node-like `process.stdin` backed by the shell's terminal input.
 *
 * This is what makes interactive CLIs work in the VM (e.g. `expo start`'s
 * keypress menu, which needs setRawMode + resume + on('data')). The shell
 * already delivers raw keypresses to `input` (a TerminalStdin) once raw mode is
 * on, so here we: toggle raw mode through `setRawMode`, and in flowing mode pump
 * `input.read()` and emit each keypress as a 'data' event (Node semantics:
 * adding a 'data' listener or calling resume() starts the flow).
 */
export function createInteractiveStdin(
  input: CommandInputStream | undefined,
  setRawMode: ((enabled: boolean) => void) | undefined,
  interactive: boolean,
) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  let flowing = false;
  let ended = false;
  let encoding: string | null = null;

  const emit = (event: string, ...args: unknown[]) => {
    (listeners[event] ? [...listeners[event]] : []).forEach((fn) => fn(...args));
  };

  async function pump() {
    while (flowing && !ended && input) {
      const chunk = await input.read();
      if (chunk === null) { ended = true; emit('end'); break; }
      if (chunk === '') continue;
      stdin.inputSeq++; // bump so the node runner sees stdin is actively read
      emit('data', encoding ? chunk : Buffer.from(chunk));
    }
  }

  const stdin = {
    isTTY: interactive,
    isRaw: false,
    /** Bumped on every input chunk; the node runner uses it to tell a
     *  live prompt (recent input) from a leftover consumer (idle). */
    inputSeq: 0,
    fd: 0,
    readable: true,
    setRawMode(v: boolean) { stdin.isRaw = !!v; setRawMode?.(!!v); return stdin; },
    resume() { if (!flowing && !ended) { flowing = true; void pump(); } return stdin; },
    pause() { flowing = false; return stdin; },
    setEncoding(enc: string) { encoding = enc; return stdin; },
    read() { return null; },
    ref() { return stdin; },
    unref() { return stdin; },
    on(event: string, fn: (...a: unknown[]) => void) {
      (listeners[event] ||= []).push(fn);
      if (event === 'data') stdin.resume();
      return stdin;
    },
    addListener(event: string, fn: (...a: unknown[]) => void) { return stdin.on(event, fn); },
    once(event: string, fn: (...a: unknown[]) => void) {
      const wrapped = (...a: unknown[]) => { stdin.off(event, wrapped); fn(...a); };
      return stdin.on(event, wrapped);
    },
    off(event: string, fn: (...a: unknown[]) => void) {
      if (listeners[event]) listeners[event] = listeners[event].filter((f) => f !== fn);
      return stdin;
    },
    removeListener(event: string, fn: (...a: unknown[]) => void) { return stdin.off(event, fn); },
    removeAllListeners(event?: string) {
      if (event) delete listeners[event]; else Object.keys(listeners).forEach((k) => delete listeners[k]);
      return stdin;
    },
    emit,
    listeners: (event: string) => (listeners[event] ? [...listeners[event]] : []),
    listenerCount: (event: string) => listeners[event]?.length ?? 0,
    pipe: () => stdin,
    destroy() { ended = true; flowing = false; return stdin; },
    /**
     * True while something is actively reading stdin (an interactive prompt is
     * waiting). The node command uses this to keep the run alive.
     *
     * Requires an actual consumer, not just `flowing`: prompt libraries (e.g.
     * `prompts`, used by create-expo-app) reset raw mode and remove their
     * keypress/data listeners on close but DON'T call `pause()`, so `flowing`
     * stays true forever. Like Node — which lets a process exit once stdin has
     * no ref'd consumer — we treat stdin as inactive when nothing is listening
     * for input, so the run can quiesce and return instead of hanging.
     */
    isActive: () => {
      if (ended || !(stdin.isRaw || flowing)) return false;
      // A 'data' listener installed by readline.emitKeypressEvents is a
      // byte->keypress translator, not a real reader — it's flagged and must
      // not, on its own, keep the run alive (prompt libs consume 'keypress').
      const dataConsumers = (listeners['data'] ?? []).filter(
        (fn) => !(fn as { __lifoKeypressSource?: boolean }).__lifoKeypressSource,
      ).length;
      return (
        dataConsumers > 0 ||
        (listeners['readable']?.length ?? 0) > 0 ||
        (listeners['keypress']?.length ?? 0) > 0
      );
    },
  };
  return stdin;
}

export class ProcessExitError extends Error {
  exitCode: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
    this.exitCode = code;
  }
}

/**
 * Build a Node-like writable stream for stdout/stderr with the tty.WriteStream
 * cursor API. When isTTY is true, CLIs (ora spinners, Expo's interface, inquirer)
 * call clearLine/cursorTo/moveCursor; we emit the matching ANSI so they render in
 * xterm instead of throwing "clearLine is not a function".
 */
function makeTtyStream(write: (data: string) => void, fd: number, isTTY: boolean) {
  const cb = (maybeCb: unknown) => { if (typeof maybeCb === 'function') (maybeCb as () => void)(); };
  return {
    write: (data: string, ...rest: unknown[]) => { write(data); cb(rest[rest.length - 1]); return true; },
    isTTY,
    fd,
    bytesWritten: 0,
    columns: 80,
    rows: 24,
    // -1 → to line start, 1 → to line end, 0/default → entire line
    clearLine: (dir: number, done?: unknown) => { write(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K'); cb(done); return true; },
    clearScreenDown: (done?: unknown) => { write('\x1b[0J'); cb(done); return true; },
    cursorTo: (x: number, y?: number | (() => void), done?: unknown) => {
      if (typeof y === 'number') write(`\x1b[${(y | 0) + 1};${(x | 0) + 1}H`);
      else { write(`\x1b[${(x | 0) + 1}G`); done = y; }
      cb(done); return true;
    },
    moveCursor: (dx: number, dy: number, done?: unknown) => {
      let s = '';
      if (dx > 0) s += `\x1b[${dx}C`; else if (dx < 0) s += `\x1b[${-dx}D`;
      if (dy > 0) s += `\x1b[${dy}B`; else if (dy < 0) s += `\x1b[${-dy}A`;
      if (s) write(s); cb(done); return true;
    },
    getColorDepth: () => (isTTY ? 8 : 1),
    hasColors: () => isTTY,
    getWindowSize: () => [80, 24],
    on: () => {},
    once: () => {},
    end: () => {},
  };
}

export interface ProcessOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  /** Interactive terminal stdin (built via createInteractiveStdin) shared across the run. */
  stdin?: ReturnType<typeof createInteractiveStdin>;
  /** True when attached to an interactive terminal → report isTTY (enables Expo's CLI UI, etc.). */
  interactive?: boolean;
  /**
   * Called by process.exit(). Returns true if the run handled the exit
   * asynchronously (the command will end on its own) — in which case exit()
   * returns WITHOUT throwing. Real process.exit() never returns, but in the VM
   * we can only throw, and a throw from an event handler (e.g. Expo's Ctrl+C
   * calls process.exit() inside a try/catch after the server stopped) gets
   * caught and mislabelled. Returning false → exit() throws ProcessExitError as
   * usual (needed to abort a still-running synchronous script).
   */
  onExit?: (code: number) => boolean;
}

export function createProcess(opts: ProcessOptions) {
  const startTime = Date.now();
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  const proc = {
    argv: ['/usr/bin/node', ...opts.argv],
    argv0: 'node',
    // Share the env object by reference — Node has a single process.env across
    // all modules in a process. (The node command copies the shell env once, so
    // this shares within the run without leaking back to the shell.) Copying
    // here would isolate each module, so `process.env.X = ...` set in an entry
    // script wouldn't be visible to required modules.
    env: opts.env,
    cwd: () => opts.cwd,
    chdir: (_dir: string) => { throw new Error('process.chdir() is not supported in Lifo'); },
    exit: (code = 0) => {
      // If the run can end the process asynchronously (long-running server,
      // main script already settled), let it — returning instead of throwing
      // so a caller like Expo's Ctrl+C handler completes its try block cleanly.
      if (opts.onExit?.(code)) return undefined as never;
      throw new ProcessExitError(code);
    },
    // Report a TTY on interactive runs so CLIs that gate their interactive UI on
    // stdout.isTTY (Expo's isInteractive(), chalk colour detection, …) turn it
    // on — matching how the command behaves in a real terminal. That also means
    // libraries like ora will call tty.WriteStream cursor methods, so we provide
    // them (emitting real ANSI so spinners/menus render in xterm).
    stdout: makeTtyStream((d) => opts.stdout.write(d), 1, !!opts.interactive),
    stderr: makeTtyStream((d) => opts.stderr.write(d), 2, !!opts.interactive),
    stdin: opts.stdin ?? {
      isTTY: false,
      isRaw: false,
      fd: 0,
      readable: true,
      setRawMode: () => {},
      on: () => {},
      once: () => {},
      off: () => {},
      removeListener: () => {},
      removeAllListeners: () => {},
      addListener: () => {},
      emit: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      read: () => null,
      ref: () => {},
      unref: () => {},
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
    // Event-loop introspection (Node 17+). expo's CLI calls this on exit to
    // report lingering handles; there is no real libuv loop here, so report none.
    getActiveResourcesInfo: (): string[] => [],
    // Source-map toggles (Node 16+). @expo/require-utils flips these around
    // SSR module evaluation; we don't consume V8 source maps, so no-op.
    setSourceMapsEnabled: (_enabled: boolean) => {},
    sourceMapsEnabled: false,
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
