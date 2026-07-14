// Unified Lifo benchmark across all environments:
//   1. in-process Node   (embed @lifo-sh/core in a Node process)
//   2. single binary     (bun --compile standalone executable, spawned per run)
//   3. browser           (headless Chromium, core loaded over HTTP)
//
// Usage:  node bench/suite/run-all.mjs [--json]
// Writes a Markdown report to bench/RESULTS.md and prints a table.
import { performance } from 'node:perf_hooks';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarize, WORKLOAD } from './workload.mjs';
import { runBrowserBench } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const JSON_OUT = process.argv.includes('--json');
const BIN = join(root, 'bench', 'dist', 'lifo-run');

function fmtBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(2) + ' MB' : (b / 1024).toFixed(0) + ' KB'; }
function gzSize(file) { return +execSync(`gzip -c "${file}" | wc -c`).toString().trim(); }
function dirSize(d) { return +execSync(`find "${d}" -type f -print0 | xargs -0 stat -f%z 2>/dev/null | awk '{s+=$1} END{print s}'`).toString().trim(); }

// Spawn the Node harness in a clean subprocess so memory (RSS) isn't polluted
// by this orchestrator's own deps (Playwright etc.).
function benchNode() {
  const r = spawnSync('node', [join(root, 'bench/node-bench.mjs'), '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('node bench failed: ' + r.stderr);
  return JSON.parse(r.stdout.trim());
}

function benchBinary(runs = 20) {
  if (!fs.existsSync(BIN)) {
    execSync(`bun build "${join(root, 'bench/bin/lifo-run.mjs')}" --compile --outfile "${BIN}"`, { stdio: 'ignore' });
  }
  spawnSync(BIN, ['true']); // warm page cache
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = spawnSync(BIN, ['true']);
    times.push(performance.now() - t);
    if (r.status !== 0) throw new Error('binary run failed: ' + r.stderr);
  }
  return { coldStart: summarize(times), sizeBytes: fs.statSync(BIN).size };
}

async function main() {
  const coreDist = join(root, 'packages/core/dist');
  const sizes = {
    coreBundleGz: gzSize(join(coreDist, fs.readdirSync(coreDist).find((f) => /^index-.*\.js$/.test(f)))),
    corePackedTgz: (() => { try { const j = JSON.parse(execSync('npm pack --dry-run --json', { cwd: join(root, 'packages/core') }).toString())[0]; return j.size; } catch { return null; } })(),
    binaryBytes: null,
  };

  const node = benchNode();
  const binary = benchBinary(WORKLOAD.bootRuns);
  sizes.binaryBytes = binary.sizeBytes;
  const browser = await runBrowserBench();

  const report = { when: new Date().toISOString(), node: process.version, sizes, envs: { node, binary, browser } };
  fs.writeFileSync(join(root, 'bench', 'RESULTS.md'), renderMd(report));
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(renderTable(report));
  console.log('\nWrote bench/RESULTS.md');
}

function renderTable(r) {
  const n = r.envs.node, b = r.envs.binary, w = r.envs.browser;
  const L = (k, a, c, br) => `  ${k.padEnd(22)} ${String(a).padEnd(16)} ${String(c).padEnd(16)} ${br}`;
  return [
    `\nLifo benchmark  (${r.node}, ${r.when.slice(0, 10)})`,
    `\n${' '.repeat(24)}${'in-process Node'.padEnd(16)}${'single binary'.padEnd(16)}browser`,
    L('boot avg', `${n.boot.avgMs.toFixed(2)} ms`, `${b.coldStart.avgMs.toFixed(1)} ms*`, `${w.boot.avgMs.toFixed(2)} ms`),
    L('boot p95', `${n.boot.p95Ms.toFixed(2)} ms`, `${b.coldStart.p95Ms.toFixed(1)} ms`, `${w.boot.p95Ms.toFixed(2)} ms`),
    L('commands', `${Math.round(n.commands.opsPerSec / 1000)}K/s`, '—', `${Math.round(w.commands.opsPerSec / 1000)}K/s`),
    L('fs write', `${Math.round(n.fs.writeOpsPerSec / 1000)}K/s`, '—', `${Math.round(w.fs.writeOpsPerSec / 1000)}K/s`),
    L('fs read', `${Math.round(n.fs.readOpsPerSec / 1000)}K/s`, '—', `${Math.round(w.fs.readOpsPerSec / 1000)}K/s`),
    L('memory', `${n.rssMB} MB rss`, '—', `${w.heapMB} MB heap`),
    `\n  * single binary = full spawn→box→command→exit (bun --compile). Browser adds core load ${w.coreLoadMs.toFixed(0)} ms (parse+eval).`,
    `\n  core: ${fmtBytes(r.sizes.coreBundleGz)} gzipped bundle · ${r.sizes.corePackedTgz ? fmtBytes(r.sizes.corePackedTgz) + ' npm tgz' : ''} · binary ${fmtBytes(r.sizes.binaryBytes)}`,
  ].join('\n');
}

function renderMd(r) {
  const n = r.envs.node, b = r.envs.binary, w = r.envs.browser;
  return `# Lifo benchmark results

_${r.when} · Node ${r.node}_

Measured with \`node bench/suite/run-all.mjs\` — the same workload
([\`bench/suite/workload.mjs\`](suite/workload.mjs)) run in three environments.

| metric | in-process Node | single binary | browser (Chromium) |
|---|---|---|---|
| boot avg | **${n.boot.avgMs.toFixed(2)} ms** | ${b.coldStart.avgMs.toFixed(1)} ms † | **${w.boot.avgMs.toFixed(2)} ms** |
| boot p50 / p95 | ${n.boot.p50Ms.toFixed(2)} / ${n.boot.p95Ms.toFixed(2)} ms | ${b.coldStart.p50Ms.toFixed(1)} / ${b.coldStart.p95Ms.toFixed(1)} ms | ${w.boot.p50Ms.toFixed(2)} / ${w.boot.p95Ms.toFixed(2)} ms |
| commands (\`true\`) | ${Math.round(n.commands.opsPerSec / 1000)}K ops/s | — | ${Math.round(w.commands.opsPerSec / 1000)}K ops/s |
| fs write (1 KiB) | ${Math.round(n.fs.writeOpsPerSec / 1000)}K ops/s | — | ${Math.round(w.fs.writeOpsPerSec / 1000)}K ops/s |
| fs read (1 KiB) | ${Math.round(n.fs.readOpsPerSec / 1000)}K ops/s | — | ${Math.round(w.fs.readOpsPerSec / 1000)}K ops/s |
| memory | ${n.rssMB} MB rss / ${n.heapMB} MB heap | — | ${w.heapMB} MB heap |

† **single binary** = a full cold start: OS spawns the standalone executable
(bun \`--compile\`), boots a fresh box, runs \`true\`, and exits — the true
"lifo as one command" latency. The in-process and browser boots measure just
\`Sandbox.create\` inside a warm runtime.

**Browser core load:** ${w.coreLoadMs.toFixed(0)} ms to fetch+parse+eval the core bundle
(localhost, so ≈ parse+eval; over the network add the ${fmtBytes(r.sizes.coreBundleGz)} gzipped transfer).

## Footprint

| artifact | size |
|---|---|
| core — gzipped bundle | ${fmtBytes(r.sizes.coreBundleGz)} |
| core — npm package (.tgz) | ${r.sizes.corePackedTgz ? fmtBytes(r.sizes.corePackedTgz) : 'n/a'} |
| single binary (bun --compile, self-contained) | ${fmtBytes(r.sizes.binaryBytes)} |

The binary is large because it embeds the whole runtime; Lifo's own code is the
~${fmtBytes(r.sizes.coreBundleGz)} bundle. No Node install, npm, or infra needed to run it.
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
