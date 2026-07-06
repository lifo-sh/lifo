export function createOs(env: Record<string, string>) {
  return {
    arch: () => 'wasm',
    platform: () => 'lifo',
    type: () => 'Lifo',
    release: () => '0.1.0',
    hostname: () => env.HOSTNAME || 'lifo',
    homedir: () => env.HOME || '/home/user',
    tmpdir: () => '/tmp',
    cpus: () => {
      const count = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      return Array.from({ length: count }, () => ({
        model: 'Browser CPU',
        speed: 2400,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      }));
    },
    availableParallelism: () => (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4,
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
    constants: {
      signals: {} as Record<string, number>,
      errno: {} as Record<string, number>,
    },
  };
}
