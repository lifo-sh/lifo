#!/usr/bin/env node
/**
 * Lifo Node benchmark harness.
 *
 * Measures the same VM that runs in the browser, here in Node: how fast a box
 * boots, how many shell commands it runs per second, and filesystem
 * throughput. First step of the "browser & Node benchmarks" roadmap item — a
 * browser harness (headless Chrome) mirrors these numbers.
 *
 *   node bench/node-bench.mjs            # human-readable table
 *   node bench/node-bench.mjs --json     # machine-readable
 *
 * Requires the core package to be built (pnpm --filter @lifo-sh/core build).
 */
import { performance } from 'node:perf_hooks';
// Import the built core directly so the harness runs from the repo root with
// plain `node` (no workspace resolution). Build first: pnpm --filter @lifo-sh/core build
import { Sandbox } from '../packages/core/dist/index.js';

const JSON_OUT = process.argv.includes('--json');

function summarize(times) {
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

async function benchBoot(runs) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const sb = await Sandbox.create({ persist: false });
    times.push(performance.now() - t);
    sb.destroy?.();
  }
  return summarize(times);
}

async function benchCommands(sb, ops) {
  // Warm up the command path once.
  await sb.commands.run('true');
  const t = performance.now();
  for (let i = 0; i < ops; i++) await sb.commands.run('true');
  const ms = performance.now() - t;
  return { ops, totalMs: ms, avgMs: ms / ops, opsPerSec: (ops / ms) * 1000 };
}

async function benchFs(sb, ops, sizeBytes) {
  const data = 'x'.repeat(sizeBytes);
  await sb.fs.writeFile('/tmp/warm', data);

  let t = performance.now();
  for (let i = 0; i < ops; i++) await sb.fs.writeFile(`/tmp/f${i}`, data);
  const writeMs = performance.now() - t;

  t = performance.now();
  for (let i = 0; i < ops; i++) await sb.fs.readFile(`/tmp/f${i}`);
  const readMs = performance.now() - t;

  return {
    ops,
    sizeBytes,
    writeOpsPerSec: (ops / writeMs) * 1000,
    readOpsPerSec: (ops / readMs) * 1000,
  };
}

async function main() {
  const node = process.version;
  const boot = await benchBoot(20);

  const sb = await Sandbox.create({ persist: false });
  const commands = await benchCommands(sb, 500);
  const fs = await benchFs(sb, 500, 1024);
  const mem = process.memoryUsage();

  const report = {
    node,
    when: new Date().toISOString(),
    boot,
    commands,
    fs,
    rssMB: +(mem.rss / 1048576).toFixed(1),
    heapUsedMB: +(mem.heapUsed / 1048576).toFixed(1),
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const row = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`\nLifo — Node benchmark  (${node})\n`);
  console.log('Boot (Sandbox.create, cold, ×20)');
  row('avg', `${boot.avgMs.toFixed(2)} ms`);
  row('p50 / p95', `${boot.p50Ms.toFixed(2)} / ${boot.p95Ms.toFixed(2)} ms`);
  row('min / max', `${boot.minMs.toFixed(2)} / ${boot.maxMs.toFixed(2)} ms`);
  console.log('\nShell commands (`true` ×500)');
  row('throughput', `${commands.opsPerSec.toFixed(0)} ops/s`);
  row('avg latency', `${commands.avgMs.toFixed(3)} ms`);
  console.log('\nFilesystem (1 KiB ×500)');
  row('write', `${fs.writeOpsPerSec.toFixed(0)} ops/s`);
  row('read', `${fs.readOpsPerSec.toFixed(0)} ops/s`);
  console.log('\nMemory');
  row('rss', `${report.rssMB} MB`);
  row('heap used', `${report.heapUsedMB} MB`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
