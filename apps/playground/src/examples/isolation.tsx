import { useEffect, useRef, useState } from 'react';
import { Sandbox, WorkerSandbox } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// The same box, two places. "In the page" is Sandbox: the box shares this page's JavaScript realm.
// "In a Web Worker" is WorkerSandbox: the page talks to the box only by messages. Each side runs
// the same program in its box (`node probe.js`) that tries to read what belongs to the page, and
// the same busy loop, while the heartbeat above them is drawn by the page's main thread.

type Side = 'page' | 'worker';
type Box = Sandbox | WorkerSandbox;
type Line = { label: string; value: string; reached: boolean };
type Result = { lines: Line[]; freeze?: number; busy?: boolean; error?: string };

const SECRET_KEY = 'lifo-isolation-demo';
const COOKIE = 'lifo_isolation_demo';

// Runs inside the box with `node`. Each check prints "label<TAB>value"; a thrown error is a block.
const PROBE = `
const check = (label, read) => {
  let value;
  try { value = read(); } catch (e) { value = 'blocked: ' + String((e && e.message) || e).split('\\n')[0].slice(0, 60); }
  console.log(label + '\\t' + value);
};
// Lifo's node hides \`document\` and \`window\` the way Node does, which isn't a wall: the page's
// globals are one property away.
const page = globalThis;
check('typeof document', () => typeof document);
check('globalThis.document', () => typeof page.document);
check('page title', () => page.document.title);
check('page localStorage', () => page.localStorage.getItem('${SECRET_KEY}'));
check('page cookie', () => page.document.cookie.split('; ').find((c) => c.startsWith('${COOKIE}=')) || '(not visible)');
check('page variable', () => String(page.__lifoPageSecret));
`;

const BUSY = `node -e "const t = Date.now(); while (Date.now() - t < 2000) {}"`;

function reachedPage(label: string, value: string): boolean {
  if (value.startsWith('blocked') || value === 'undefined' || value === '(not visible)' || value === 'null') return false;
  if (label === 'typeof document' || label === 'globalThis.document') return value === 'object';
  return true;
}

function parse(stdout: string): Line[] {
  return stdout
    .split('\n')
    .filter((l) => l.includes('\t'))
    .map((l) => {
      const [label, value] = l.split('\t');
      return { label, value, reached: reachedPage(label, value) };
    });
}

/** The longest gap between two animation frames while `work` runs: how long the page froze. */
async function longestFrameGap(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  let on = true;
  const tick = (t: number) => {
    worst = Math.max(worst, t - last);
    last = t;
    if (on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    await work();
    // Two more frames, so a freeze that ends with the work is counted.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  } finally {
    on = false;
  }
  return Math.round(Math.max(worst, performance.now() - last));
}

function Heartbeat() {
  const dot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const frame = (t: number) => {
      const x = ((t - start) / 1200) % 2;
      if (dot.current) dot.current.style.left = `calc(${(x < 1 ? x : 2 - x) * 100}% - ${(x < 1 ? x : 2 - x) * 12}px)`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="flex items-center gap-3 text-[12px] text-tokyo-comment">
      <span className="shrink-0">Page heartbeat</span>
      <div className="relative h-3 flex-1 max-w-[260px] rounded-full bg-tokyo-bg-darker border border-tokyo-border">
        <div ref={dot} className="absolute top-[1px] h-2 w-3 rounded-full bg-tokyo-cyan" />
      </div>
      <span className="hidden sm:inline">drawn by the page's main thread; it stops when the page freezes</span>
    </div>
  );
}

function Column({
  side,
  ready,
  result,
  onProbe,
  onBusy,
}: {
  side: Side;
  ready: boolean;
  result: Result | null;
  onProbe: () => void;
  onBusy: () => void;
}) {
  const reached = result?.lines.filter((l) => l.reached).length ?? 0;
  const busy = !!result?.busy;
  return (
    <div className="flex flex-col min-h-0 min-w-0 flex-1 border-tokyo-border first:border-b md:first:border-b-0 md:first:border-r">
      <div className="px-4 pt-3 pb-2 border-b border-tokyo-border bg-tokyo-bg-dark">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-tokyo-fg-bright">{side === 'page' ? 'In the page' : 'In a Web Worker'}</span>
          <code className="text-[11.5px] text-tokyo-comment">{side === 'page' ? "Sandbox.create({ realm: 'page' })" : 'WorkerSandbox.create({ worker })'}</code>
        </div>
        <p className="mt-1 text-[12px] text-tokyo-comment">
          {side === 'page'
            ? "The box shares this page's JavaScript realm and main thread."
            : 'The box runs in its own thread and realm; the page talks to it by messages.'}
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="xs" onClick={onProbe} disabled={!ready || busy}>
            Run the probe
          </Button>
          <Button size="xs" variant="outline" onClick={onBusy} disabled={!ready || busy}>
            Busy loop, 2 s
          </Button>
          {!ready && <span className="text-[12px] text-tokyo-comment self-center">booting…</span>}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 font-code text-[12px] leading-relaxed bg-tokyo-bg-dark">
        {result?.error && <div className="text-[#f7768e]">Error: {result.error}</div>}
        {result?.lines.length ? (
          <>
            <div className="text-tokyo-comment mb-1">$ node probe.js</div>
            {result.lines.map((l) => (
              <div key={l.label} className="flex gap-3">
                <span className="w-[150px] shrink-0 text-tokyo-comment">{l.label}</span>
                <span className={cn('break-all', l.reached ? 'text-[#f7768e]' : 'text-tokyo-green')}>{l.value}</span>
              </div>
            ))}
            <div className={cn('mt-2 font-sans text-[12.5px]', reached ? 'text-[#f7768e]' : 'text-tokyo-green')}>
              {reached
                ? `Reached the page in ${reached} of ${result.lines.length} checks.`
                : `Reached nothing of the page (0 of ${result.lines.length}).`}
            </div>
          </>
        ) : null}
        {busy && <div className="mt-3 text-tokyo-orange">Running a 2 s busy loop in the box…</div>}
        {result?.freeze !== undefined && !busy && (
          <div className={cn('mt-3 font-sans text-[12.5px]', result.freeze > 200 ? 'text-[#f7768e]' : 'text-tokyo-green')}>
            Busy loop: the page's longest frame was {result.freeze.toLocaleString()} ms
            {result.freeze > 200 ? ', so the page froze.' : ', so the page kept drawing.'}
          </div>
        )}
        {!result && ready && (
          <div className="font-sans text-tokyo-comment">
            Run the probe to see what code in this box can read of the page, or the busy loop to see whether it freezes the page.
          </div>
        )}
      </div>
    </div>
  );
}

export default function IsolationExample() {
  const boxes = useRef<Partial<Record<Side, Box>>>({});
  const [ready, setReady] = useState<Record<Side, boolean>>({ page: false, worker: false });
  const [results, setResults] = useState<Record<Side, Result | null>>({ page: null, worker: null });

  useEffect(() => {
    // What the probe looks for: things only this page has.
    const secret = 'page-only-' + Math.random().toString(36).slice(2, 8);
    try {
      localStorage.setItem(SECRET_KEY, secret);
    } catch {
      /* storage blocked */
    }
    document.cookie = `${COOKIE}=${secret}; path=/; max-age=600; SameSite=Lax`;
    (globalThis as { __lifoPageSecret?: string }).__lifoPageSecret = secret;

    let gone = false;
    const boot = async (side: Side) => {
      const box: Box =
        side === 'page'
          ? // realm: 'page' says the in-page box is intended (it hides Sandbox's console note).
            await Sandbox.create({ realm: 'page' })
          : await WorkerSandbox.create({
              worker: () => new Worker(new URL('../lib/box.worker.ts', import.meta.url), { type: 'module', name: 'lifo-isolation-box' }),
            });
      if (gone) return box.destroy();
      await box.fs.writeFile('/home/user/probe.js', PROBE);
      boxes.current[side] = box;
      setReady((r) => ({ ...r, [side]: true }));
    };
    for (const side of ['page', 'worker'] as const) {
      boot(side).catch((e: Error) => !gone && setResults((r) => ({ ...r, [side]: { lines: [], error: e.message } })));
    }
    return () => {
      gone = true;
      boxes.current.page?.destroy();
      boxes.current.worker?.destroy();
      boxes.current = {};
      delete (globalThis as { __lifoPageSecret?: string }).__lifoPageSecret;
      try {
        localStorage.removeItem(SECRET_KEY);
      } catch {
        /* storage blocked */
      }
      document.cookie = `${COOKIE}=; path=/; max-age=0`;
    };
  }, []);

  const update = (side: Side, patch: Partial<Result>) =>
    setResults((r) => ({ ...r, [side]: { lines: [], ...r[side], ...patch } }));

  const probe = async (side: Side) => {
    const box = boxes.current[side];
    if (!box) return;
    try {
      const r = await box.commands.run('node /home/user/probe.js');
      update(side, { lines: parse(r.stdout), error: r.exitCode ? r.stderr.trim() || `exit ${r.exitCode}` : undefined });
    } catch (e) {
      update(side, { error: (e as Error).message });
    }
  };

  const busyLoop = async (side: Side) => {
    const box = boxes.current[side];
    if (!box) return;
    update(side, { busy: true, freeze: undefined });
    // Let React paint the "running" state before the loop can freeze the page.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      const freeze = await longestFrameGap(() => box.commands.run(BUSY));
      update(side, { busy: false, freeze });
    } catch (e) {
      update(side, { busy: false, error: (e as Error).message });
    }
  };

  return (
    <ExamplePanel
      title="Isolation: page vs Web Worker"
      subtitle={
        <>
          Two Lifo boxes run the same program. The one in the page (<code>Sandbox</code>) can read this page's title,
          storage, cookies and variables, and a busy loop in it freezes the page. The one in a Web Worker
          (<code>WorkerSandbox</code>) can't reach any of them, and the page keeps drawing while it works. On lifo.sh with
          a box domain, the worker also runs on a different site, so even the browser's per-site storage is separate.
        </>
      }
    >
      <div className="flex flex-col flex-1 min-h-0">
        <div className="px-4 py-2 border-b border-tokyo-border bg-tokyo-bg-darker">
          <Heartbeat />
        </div>
        <div className="flex flex-col md:flex-row flex-1 min-h-0">
          {(['page', 'worker'] as const).map((side) => (
            <Column
              key={side}
              side={side}
              ready={ready[side]}
              result={results[side]}
              onProbe={() => void probe(side)}
              onBusy={() => void busyLoop(side)}
            />
          ))}
        </div>
      </div>
    </ExamplePanel>
  );
}
