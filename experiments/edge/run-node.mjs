import { lifoRun } from './dist/lifo-run.mjs';
const before = process.memoryUsage().rss;
const r = await lifoRun();
console.log(JSON.stringify({ host: 'node ' + process.version, rssMB: Math.round(process.memoryUsage().rss / 1048576), rssAddedMB: Math.round((process.memoryUsage().rss - before) / 1048576), ...r }));
process.exit(0);
