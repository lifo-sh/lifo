import { useEffect, useMemo, useState } from 'react';
import { Kernel } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { TerminalArea } from '@/components/terminal-area';
import { FileExplorerView } from '@/components/file-explorer-view';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { createMonacoProvider, setMonacoTheme } from '@/lib/monaco';
import { bootShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';

const DIR = '/home/user/py';

const FILES: Record<string, string> = {
  'sales.csv': `region,product,units,price
EU,lamp,12,40
US,lamp,30,38
EU,desk,4,320
APAC,chair,18,95
US,desk,9,310
APAC,lamp,25,41
EU,chair,7,99
US,chair,22,92
`,
  'report.py': `"""Summarize sales.csv with the standard library, then write summary.json.

Run it in the terminal below:  python3 report.py
"""
import csv, json, platform
from collections import defaultdict

totals = defaultdict(float)
with open("sales.csv") as f:
    for row in csv.DictReader(f):
        totals[row["region"]] += int(row["units"]) * float(row["price"])

print(f"Python {platform.python_version()} on {platform.machine()}\\n")
print(f"{'region':<8}{'revenue':>10}")
for region, revenue in sorted(totals.items(), key=lambda kv: -kv[1]):
    print(f"{region:<8}{revenue:>10,.0f}  " + "#" * int(revenue / 500))

with open("summary.json", "w") as f:
    json.dump({"top": max(totals, key=totals.get), "total": sum(totals.values())}, f, indent=2)
    f.write("\\n")
print("\\nwrote summary.json")
`,
  'stats.py': `# numpy is built by Pyodide: importing it downloads it the first time.
import numpy as np

units = np.array([12, 30, 4, 18, 9, 25, 7, 22])
print("mean", units.mean(), "std", round(float(units.std()), 2))
`,
};

export default function PythonExample() {
  const editorProvider = useMemo(() => createMonacoProvider(), []);
  const [kernel, setKernel] = useState<Kernel | null>(null);
  const { mode } = useTheme();

  useEffect(() => {
    setMonacoTheme(mode);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const k = new Kernel();
      await k.boot({ persist: false });
      if (cancelled) return;
      k.vfs.mkdir(DIR, { recursive: true });
      for (const [name, text] of Object.entries(FILES)) k.vfs.writeFile(`${DIR}/${name}`, text);
      setKernel(k);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const box = kernel ? { kernel, env: kernel.getDefaultEnv() } : null;

  return (
    <ExamplePanel
      title="Python"
      subtitle={
        <>
          CPython 3 on WebAssembly (Pyodide), with the box&apos;s files. Try <code>python3 report.py</code>, then{' '}
          <code>cat summary.json</code>; <code>python3 stats.py</code> loads numpy; <code>pip install rich</code>; or{' '}
          <code>python3</code> for a prompt. The first run downloads the interpreter (about 6 MB).
        </>
      }
    >
      {kernel ? (
        <ResizablePanelGroup direction="vertical" autoSaveId="pg-python-split" className="flex-1 min-h-0">
          <ResizablePanel defaultSize={55} minSize={25}>
            <div className="w-full h-full overflow-hidden">
              <FileExplorerView vfs={kernel.vfs} cwd={DIR} editorProvider={editorProvider} className="w-full h-full" />
            </div>
          </ResizablePanel>
          <ResizableHandle className="my-0.5" />
          <ResizablePanel defaultSize={45} minSize={15}>
            <TerminalArea box={box} bootTab={(term) => void bootShell(term, kernel, { cwd: DIR })} />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : null}
    </ExamplePanel>
  );
}
