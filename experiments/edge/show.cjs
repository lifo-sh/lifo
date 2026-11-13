const s = require('fs').readFileSync(process.argv[2], 'utf8');
const line = s.split('\n').reverse().find((l) => l.trim().startsWith('{'));
if (!line) { console.log(s.slice(-1500)); process.exit(1); }
const r = JSON.parse(line);
console.log(r.host, '| boot', r.bootMs, 'ms | total', r.totalMs, 'ms', r.rssMB ? `| rss ${r.rssMB} MB (+${r.rssAddedMB})` : '');
console.log('caps', JSON.stringify(r.caps));
for (const x of r.results) console.log(' ', x.exit, String(x.ms).padStart(5) + 'ms', x.label.padEnd(12), '|', x.out.replace(/\n/g, ' / ').slice(0, 110));
console.log('  snapshot', JSON.stringify(r.snapshot));
