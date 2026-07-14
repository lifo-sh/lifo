// Shared, environment-agnostic benchmark workload. Both the Node and the
// browser harnesses import this and pass in their own Sandbox, so the numbers
// are apples-to-apples across environments.

export function summarize(times) {
  const s = [...times].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    runs: s.length,
    avgMs: sum / s.length,
    p50Ms: s[Math.floor(s.length * 0.5)],
    p95Ms: s[Math.floor(s.length * 0.95)],
    minMs: s[0],
    maxMs: s[s.length - 1],
  };
}

/** Cold Sandbox.create() ×runs. */
export async function benchBoot(Sandbox, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const sb = await Sandbox.create({ persist: false });
    times.push(performance.now() - t);
    sb.destroy?.();
  }
  return summarize(times);
}

/** Shell command throughput (`true` ×ops). */
export async function benchCommands(sb, ops) {
  await sb.commands.run('true'); // warm the path
  const t = performance.now();
  for (let i = 0; i < ops; i++) await sb.commands.run('true');
  const ms = performance.now() - t;
  return { ops, totalMs: ms, avgMs: ms / ops, opsPerSec: (ops / ms) * 1000 };
}

/** Filesystem write/read throughput (sizeBytes ×ops). */
export async function benchFs(sb, ops, sizeBytes) {
  const data = 'x'.repeat(sizeBytes);
  await sb.fs.writeFile('/tmp/warm', data);

  let t = performance.now();
  for (let i = 0; i < ops; i++) await sb.fs.writeFile(`/tmp/f${i}`, data);
  const writeMs = performance.now() - t;

  t = performance.now();
  for (let i = 0; i < ops; i++) await sb.fs.readFile(`/tmp/f${i}`);
  const readMs = performance.now() - t;

  return { ops, sizeBytes, writeOpsPerSec: (ops / writeMs) * 1000, readOpsPerSec: (ops / readMs) * 1000 };
}

export const WORKLOAD = { bootRuns: 20, cmdOps: 500, fsOps: 500, fsSize: 1024 };
