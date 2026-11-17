// Vercel's Edge runtime, locally: the edge-runtime package (the same VM Next.js and `vercel dev` use).
import { EdgeRuntime } from 'edge-runtime';
import fs from 'node:fs';
const code = fs.readFileSync(new URL('./dist/lifo-run.iife.js', import.meta.url), 'utf8');
const before = process.memoryUsage().rss;
const runtime = new EdgeRuntime({ initialCode: code });
const r = await runtime.evaluate(`LifoEdge.lifoRun().then((r) => JSON.stringify(r), (e) => JSON.stringify({ error: String(e && e.stack || e) }))`);
const out = JSON.parse(r);
console.log(JSON.stringify({ host: 'vercel edge-runtime ' + JSON.parse(fs.readFileSync(new URL('./node_modules/edge-runtime/package.json', import.meta.url))).version, rssMB: Math.round(process.memoryUsage().rss / 1048576), rssAddedMB: Math.round((process.memoryUsage().rss - before) / 1048576), ...out }));
process.exit(0);
