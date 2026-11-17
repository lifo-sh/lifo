// Run with code generation off, as on Cloudflare Workers and Vercel Edge:
//   node --disallow-code-generation-from-strings --test adapter/
import test from 'node:test';
import assert from 'node:assert/strict';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import { createEdgeSandbox, hostCapabilities, installGzipFallback } from './lifo-edge.js';

const quickjs = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);

test('the host forbids code generation (the flag is on)', () => {
  assert.equal(hostCapabilities().codegen, false);
});

test('shell, builtins and files work unchanged', async () => {
  const box = await createEdgeSandbox();
  const r = await box.commands.run('mkdir -p /tmp/t && printf "b\\na\\n" > /tmp/t/x && cat /tmp/t/x | sort | head -1 | tr a-z A-Z');
  assert.equal(r.stdout.trim(), 'A');
  box.destroy();
});

test('without QuickJS, node explains why it cannot run', async () => {
  const box = await createEdgeSandbox();
  assert.equal(box.edge.node, 'unavailable');
  const r = await box.commands.run('node -e "console.log(1)"');
  assert.equal(r.exitCode, 126);
  assert.match(r.stderr, /forbids code generation/);
  box.destroy();
});

test('node -e and -p run on QuickJS', async () => {
  const box = await createEdgeSandbox({ quickjs });
  assert.equal(box.edge.node, 'quickjs');
  assert.equal((await box.commands.run('node -e "console.log(6 * 7, [1, 2])"')).stdout, '42 [1,2]\n');
  assert.equal((await box.commands.run('node -p "process.argv.length"')).stdout, '1\n');
  box.destroy();
});

test('a script with require of its own files, fs and path, args and exit code', async () => {
  const box = await createEdgeSandbox({ quickjs });
  await box.fs.mkdir('/home/user/app/lib', { recursive: true });
  await box.fs.writeFile('/home/user/app/lib/sum.js', 'module.exports = (xs) => xs.reduce((a, b) => a + b, 0);');
  await box.fs.writeFile('/home/user/app/data.json', '{"xs":[1,2,3,4]}');
  await box.fs.writeFile('/home/user/app/main.js', [
    "const fs = require('fs'); const path = require('path'); const sum = require('./lib/sum');",
    "const { xs } = require('./data.json');",
    "fs.writeFileSync(path.join(__dirname, 'out.txt'), String(sum(xs)));",
    "console.log('args', process.argv.slice(2).join(','), 'cwd', process.cwd());",
    'process.exit(3);',
  ].join('\n'));
  const r = await box.commands.run('cd /home/user/app && node main.js a b');
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, 'args a,b cwd /home/user/app\n');
  assert.equal(await box.fs.readFile('/home/user/app/out.txt', 'utf8'), '10');
  box.destroy();
});

test('errors print a stack and exit 1; unknown modules say what is available', async () => {
  const box = await createEdgeSandbox({ quickjs });
  const r = await box.commands.run(`node -e "require('http')"`);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /isn't available on QuickJS/);
  box.destroy();
});

test('a runaway script is stopped at its CPU budget', async () => {
  const { quickjsNode } = await import('./lifo-edge.js');
  const box = await createEdgeSandbox();
  box.commands.register('node', quickjsNode(quickjs, { cpuMs: 200 }));
  const t = Date.now();
  const r = await box.commands.run('node -e "for (;;) {}"');
  assert.equal(r.exitCode, 124);
  assert.ok(Date.now() - t < 3000);
  box.destroy();
});

test('gzip fallback: tar -z and snapshots without CompressionStream', async () => {
  const saved = [globalThis.CompressionStream, globalThis.DecompressionStream];
  try {
    installGzipFallback({ force: true });
    const box = await createEdgeSandbox();
    const r = await box.commands.run('mkdir -p /tmp/g && echo hi > /tmp/g/a && cd /tmp && tar -czf g.tgz g && rm -r g && tar -xzf g.tgz && cat g/a');
    assert.equal(r.stdout.trim(), 'hi');
    const snap = await box.exportSnapshot();
    const box2 = await createEdgeSandbox();
    await box2.importSnapshot(snap);
    assert.equal((await box2.commands.run('cat /tmp/g/a')).stdout.trim(), 'hi');
    box.destroy();
    box2.destroy();
  } finally {
    [globalThis.CompressionStream, globalThis.DecompressionStream] = saved;
  }
});
