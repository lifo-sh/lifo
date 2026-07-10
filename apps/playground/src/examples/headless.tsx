import { useRef, useState } from 'react';
import { Sandbox } from '@lifo-sh/core';
import { ExamplePanel } from '@/components/example-panel';
import { Button } from '@/components/ui/button';

export default function HeadlessExample() {
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const sandboxRef = useRef<Sandbox | null>(null);

  async function run() {
    setRunning(true);
    let out = 'Running...\n';
    setOutput(out);
    const log = (text: string) => {
      out += text;
      setOutput(out);
    };
    sandboxRef.current?.destroy();
    try {
      log('> Creating sandbox...\n');
      const sandbox = await Sandbox.create();
      sandboxRef.current = sandbox;
      log('  Sandbox ready. cwd = ' + sandbox.cwd + '\n\n');

      log('> sandbox.commands.run(\'echo "Hello from Lifo!"\')\n');
      const r1 = await sandbox.commands.run('echo "Hello from Lifo!"');
      log('  stdout: ' + JSON.stringify(r1.stdout) + '\n');
      log('  exitCode: ' + r1.exitCode + '\n\n');

      log("> sandbox.fs.writeFile('/home/user/app.js', ...)\n");
      await sandbox.fs.writeFile('/home/user/app.js', 'console.log("hi")');
      log('  Done.\n\n');

      log("> sandbox.fs.readFile('/home/user/app.js')\n");
      const content = await sandbox.fs.readFile('/home/user/app.js');
      log('  content: ' + JSON.stringify(content) + '\n\n');

      log("> sandbox.commands.run('export GREETING=world')\n");
      await sandbox.commands.run('export GREETING=world');
      log('  Done.\n\n');

      log("> sandbox.commands.run('echo $GREETING | cat')\n");
      const r2 = await sandbox.commands.run('echo $GREETING | cat');
      log('  stdout: ' + JSON.stringify(r2.stdout) + '\n\n');

      log("> sandbox.fs.readdir('/home/user')\n");
      const entries = await sandbox.fs.readdir('/home/user');
      for (const e of entries) {
        log('  ' + (e.type === 'directory' ? '/' : ' ') + e.name + '\n');
      }
      log('\n');

      log('> sandbox.destroy()\n');
      sandbox.destroy();
      sandboxRef.current = null;
      log('  Done. All resources released.\n');
    } catch (e) {
      log('\nError: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    } finally {
      setRunning(false);
    }
  }

  return (
    <ExamplePanel title="Headless / AI Agent" subtitle="Programmatic command execution — no terminal UI">
      <div className="flex flex-col flex-1 min-h-0 p-2 gap-2">
        <Button size="sm" onClick={run} disabled={running} className="self-start">
          {running ? 'Running…' : 'Run'}
        </Button>
        <pre className="flex-1 min-h-0 bg-tokyo-bg-dark border border-tokyo-border rounded-md px-4 py-3.5 font-code text-xs leading-relaxed whitespace-pre-wrap text-tokyo-fg overflow-y-auto">
          {output || 'Click Run to execute the headless demo (Sandbox API — no terminal).'}
        </pre>
      </div>
    </ExamplePanel>
  );
}
