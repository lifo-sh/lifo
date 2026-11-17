import { lifoRun } from './dist/lifo-run.mjs';
const before = Deno.memoryUsage().rss;
const r = await lifoRun();
console.log(JSON.stringify({ host: 'deno ' + Deno.version.deno, rssMB: Math.round(Deno.memoryUsage().rss / 1048576), rssAddedMB: Math.round((Deno.memoryUsage().rss - before) / 1048576), ...r }));
Deno.exit(0);
