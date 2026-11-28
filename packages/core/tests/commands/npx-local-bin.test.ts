// `npx <command>` runs a command an installed package provides, under its own name, the way npm
// finds it in node_modules/.bin: `npx tsc` is the project's typescript, not the registry's "tsc".
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('npx and local commands', () => {
	it('runs a bin from an installed package whose name differs from the command', async () => {
		const box = await Sandbox.create({ persist: false });
		await box.fs.mkdir('/home/user/app/node_modules/typescript/bin', { recursive: true });
		await box.fs.writeFile('/home/user/app/node_modules/typescript/package.json', JSON.stringify({
			name: 'typescript', version: '5.9.3', bin: { tsc: './bin/tsc', tsserver: './bin/tsserver' },
		}));
		await box.fs.writeFile('/home/user/app/node_modules/typescript/bin/tsc', `console.log('local tsc', process.argv.slice(2).join(' '));\n`);
		const r = await box.commands.run('cd /home/user/app && npx tsc --noEmit');
		expect(r.stdout).toBe('local tsc --noEmit\n');
		expect(r.exitCode).toBe(0);
	});
});
