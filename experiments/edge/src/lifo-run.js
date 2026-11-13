// Boot a Lifo box and run the shell, builtins, files, snapshots, tar/gzip and git in it.
// Returns timings and outputs, so each host can be compared on the same work.
import { Sandbox } from '@lifo-sh/core';
import { probe } from './probe.js';
import gitCommand from 'lifo-pkg-git';

const STEPS = [
  ['echo + pipes', 'echo hello edge | tr a-z A-Z | sed s/EDGE/LIFO/'],
  ['files', 'mkdir -p /home/user/p && cd /home/user/p && printf "b\\na\\nc\\n" > x.txt && sort x.txt | head -2 && wc -l x.txt'],
  ['grep + awk', 'printf "a 1\\nb 2\\nc 3\\n" | awk \'{ print $2 }\' | grep -c "[0-9]"'],
  ['ls + cat', 'ls /home/user/p && cat /home/user/p/x.txt | head -1'],
  ['tar + gzip', 'cd /home/user && tar -czf p.tgz p && rm -r p && tar -xzf p.tgz && cat p/x.txt | wc -l'],
  ['node -e', 'node -e "console.log(6 * 7)"'],
  ['curl', 'curl -s https://example.com | head -c 60'],
  ['git', 'cd /home/user/p && git init -q && git add . && GIT_AUTHOR_NAME=e GIT_AUTHOR_EMAIL=e@x git commit -q -m one && git log --oneline | wc -l'],
];

export async function lifoRun({ skipNetwork = false, extra = [] } = {}) {
  const t0 = performance.now();
  const caps = await probe();
  const t1 = performance.now();
  const box = await Sandbox.create();
  box.commands.register('git', gitCommand);
  const bootMs = performance.now() - t1;
  const results = [];
  for (const [label, cmd] of [...STEPS, ...extra]) {
    if (skipNetwork && label === 'curl') continue;
    const s = performance.now();
    try {
      const r = await box.commands.run(cmd, { timeout: 20000 });
      results.push({ label, exit: r.exitCode, ms: Math.round(performance.now() - s), out: (r.stdout + r.stderr).trim().slice(0, 160) });
    } catch (e) {
      results.push({ label, exit: 'threw', ms: Math.round(performance.now() - s), out: String(e && e.message || e).slice(0, 160) });
    }
  }
  // Snapshot round trip into a second box.
  const s = performance.now();
  let snapshot;
  try {
    const bytes = await box.exportSnapshot();
    const box2 = await Sandbox.create();
    await box2.importSnapshot(bytes);
    const r = await box2.commands.run('cat /home/user/p/x.txt | wc -l');
    snapshot = { ok: r.stdout.trim() === '3', bytes: bytes.byteLength, ms: Math.round(performance.now() - s) };
    box2.destroy();
  } catch (e) {
    snapshot = { ok: false, error: String(e && e.message || e).slice(0, 160) };
  }
  box.destroy();
  return { caps, bootMs: Math.round(bootMs * 10) / 10, results, snapshot, totalMs: Math.round(performance.now() - t0) };
}
