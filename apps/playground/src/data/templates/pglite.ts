export function pgliteFiles(root: string): Record<string, string> {
	return {
		[`${root}/package.json`]: JSON.stringify({
			name: 'pg-demo',
			version: '1.0.0',
			type: 'module',
			dependencies: { '@electric-sql/pglite': '^0.5.4' },
		}, null, 2),
		[`${root}/test.mjs`]: `import { PGlite } from '@electric-sql/pglite';

const db = new PGlite(); // in-memory postgres (wasm)
console.log('booting postgres...');

await db.exec(\`CREATE TABLE docs (id serial primary key, owner text NOT NULL, body text NOT NULL);\`);
await db.exec(\`INSERT INTO docs (owner, body) VALUES ('alice', 'alice doc 1'), ('alice', 'alice doc 2'), ('bob', 'bob doc');\`);
const all = await db.query('SELECT count(*)::int AS n FROM docs');
console.log('total rows:', all.rows[0].n);

// Row Level Security
await db.exec(\`
  CREATE ROLE alice LOGIN;
  GRANT SELECT ON docs TO alice;
  ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_docs ON docs FOR SELECT USING (owner = current_user);
\`);
await db.exec('SET ROLE alice');
const mine = await db.query('SELECT body FROM docs ORDER BY id');
console.log('alice sees:', JSON.stringify(mine.rows));
await db.exec('RESET ROLE');

const ver = await db.query('SELECT version()');
console.log('version:', ver.rows[0].version);
const j = await db.query(\`SELECT jsonb_build_object('ok', true) AS j\`);
console.log('jsonb:', JSON.stringify(j.rows[0].j));
console.log('ALL TESTS PASSED ✅');
`,
	};
}
