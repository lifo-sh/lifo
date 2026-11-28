// require.cache is a live view of the run's loaded files: deleting an entry makes the next
// require() run the file again (how Next.js reloads its rebuilt server bundles).
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('require.cache', () => {
	it('lists loaded files, evicts on delete, and takes injected modules', async () => {
		const box = await Sandbox.create({ persist: false });
		await box.fs.mkdir('/tmp/rc', { recursive: true });
		await box.fs.writeFile('/tmp/rc/mod.js', 'module.exports = { v: 1 };');
		await box.fs.writeFile('/tmp/rc/main.js', [
			`const fs = require('fs');`,
			`const file = require.resolve('./mod.js');`,
			`const first = require('./mod.js');`,
			`console.log(file in require.cache, Object.keys(require.cache).includes(file), require.cache[file].exports === first, require.cache[file].filename);`,
			`fs.writeFileSync(file, 'module.exports = { v: 2 };');`,
			`console.log(require('./mod.js').v);`,
			`delete require.cache[file];`,
			`console.log(file in require.cache, require('./mod.js').v);`,
			`require.cache['/tmp/rc/fake.js'] = { exports: { injected: true } };`,
			`console.log(require('/tmp/rc/fake.js').injected);`,
		].join('\n'));
		const r = await box.commands.run('node /tmp/rc/main.js');
		expect(r.stdout).toBe('true true true /tmp/rc/mod.js\n1\nfalse 2\ntrue\n');
	});
});
