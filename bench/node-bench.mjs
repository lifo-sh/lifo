#!/usr/bin/env node
/**
 * Lifo Node benchmark — in-process (embed @lifo-sh/core in a Node process).
 * Measures how fast a box boots, shell command throughput, filesystem
 * throughput, and memory. Part of the "browser & Node benchmarks" roadmap item.
 *
 *   node bench/node-bench.mjs            # human-readable
 *   node bench/node-bench.mjs --json     # machine-readable (used by run-all)
 *
 * Build core first: pnpm --filter @lifo-sh/core build
 */
import { Sandbox } from '../packages/core/dist/index.js';
import { benchBoot, benchCommands, benchFs, WORKLOAD } from './suite/workload.mjs';

const JSON_OUT = process.argv.includes('--json');

const boot = await benchBoot(Sandbox, WORKLOAD.bootRuns);
const sb = await Sandbox.create({ persist: false });
const commands = await benchCommands(sb, WORKLOAD.cmdOps);
const fs = await benchFs(sb, WORKLOAD.fsOps, WORKLOAD.fsSize);
const mem = process.memoryUsage();
const report = {
  node: process.version, when: new Date().toISOString(),
  boot, commands, fs,
  rssMB: +(mem.rss / 1048576).toFixed(1), heapMB: +(mem.heapUsed / 1048576).toFixed(1),
};

if (JSON_OUT) { console.log(JSON.stringify(report)); process.exit(0); }

const row = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
console.log(`\nLifo — Node benchmark  (${report.node})\n`);
console.log('Boot (Sandbox.create, cold, ×20)');
row('avg', `${boot.avgMs.toFixed(2)} ms`);
row('p50 / p95', `${boot.p50Ms.toFixed(2)} / ${boot.p95Ms.toFixed(2)} ms`);
row('min / max', `${boot.minMs.toFixed(2)} / ${boot.maxMs.toFixed(2)} ms`);
console.log('\nShell commands (`true` ×500)');
row('throughput', `${Math.round(commands.opsPerSec)} ops/s`);
row('avg latency', `${commands.avgMs.toFixed(3)} ms`);
console.log('\nFilesystem (1 KiB ×500)');
row('write', `${Math.round(fs.writeOpsPerSec)} ops/s`);
row('read', `${Math.round(fs.readOpsPerSec)} ops/s`);
console.log('\nMemory');
row('rss', `${report.rssMB} MB`);
row('heap used', `${report.heapMB} MB`);
console.log('');
