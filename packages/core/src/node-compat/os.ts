export function createOs(env: Record<string, string>) {
  return {
    arch: () => 'wasm',
    platform: () => 'lifo',
    type: () => 'Lifo',
    release: () => '0.1.0',
    hostname: () => env.HOSTNAME || 'lifo',
    homedir: () => env.HOME || '/home/user',
    tmpdir: () => '/tmp',
    // Report a single CPU. The VM has no real threads or child_process, so tools
    // that scale worker pools by core count (Metro/jest-worker fork one worker
    // per CPU) would otherwise spawn workers that can't be serviced and hang.
    // One core makes them run in-band — accurate for the VM and what lets a
    // stock `expo start` (no maxWorkers override) work without freezing.
    cpus: () => [{
      model: 'Lifo CPU',
      speed: 2400,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }],
    availableParallelism: () => 1,
    totalmem: () => {
      const m = (performance as unknown as { memory?: { jsHeapSizeLimit: number } }).memory;
      return m?.jsHeapSizeLimit ?? 4 * 1024 * 1024 * 1024;
    },
    freemem: () => {
      const m = (performance as unknown as { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number } }).memory;
      if (m) return m.jsHeapSizeLimit - m.usedJSHeapSize;
      return 2 * 1024 * 1024 * 1024;
    },
    uptime: () => Math.floor(performance.now() / 1000),
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    userInfo: () => ({
      uid: 1000,
      gid: 1000,
      username: env.USER || 'user',
      homedir: env.HOME || '/home/user',
      shell: env.SHELL || '/bin/sh',
    }),
    EOL: '\n',
    endianness: () => 'LE' as const,
    // Linux's numbers, as Node reports them there (execa checks signal names against these).
    constants: {
      signals: { ...LINUX_SIGNALS },
      errno: { ...LINUX_ERRNO },
      priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
    },
  };
}

const LINUX_SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: 7,
  SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
  SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
  SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28,
  SIGIO: 29, SIGPOLL: 29, SIGPWR: 30, SIGSYS: 31,
};

const LINUX_ERRNO: Record<string, number> = {
  EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9,
  ECHILD: 10, EAGAIN: 11, EWOULDBLOCK: 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, EBUSY: 16,
  EEXIST: 17, EXDEV: 18, ENODEV: 19, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24,
  ENOTTY: 25, ETXTBSY: 26, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30, EMLINK: 31, EPIPE: 32,
  EDOM: 33, ERANGE: 34, EDEADLK: 35, ENAMETOOLONG: 36, ENOLCK: 37, ENOSYS: 38, ENOTEMPTY: 39,
  ELOOP: 40, ENOTSUP: 95, EOPNOTSUPP: 95, EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETDOWN: 100,
  ENETUNREACH: 101, ECONNABORTED: 103, ECONNRESET: 104, ENOBUFS: 105, EISCONN: 106,
  ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111, EHOSTUNREACH: 113, EALREADY: 114,
  EINPROGRESS: 115, ECANCELED: 125,
};
