import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

/** A box whose browser-metro and npm just record how they were called. */
async function boxWithSpies() {
	const box = await Sandbox.create();
	const calls: { name: string; args: string[] }[] = [];
	for (const name of ['browser-metro', 'npm']) {
		box.commands.register(name, async (ctx) => {
			calls.push({ name, args: ctx.args });
			return 0;
		});
	}
	return { box, calls };
}

describe('expo in a box', () => {
	it('expo start runs browser-metro with the dir and port, and says so', async () => {
		const { box, calls } = await boxWithSpies();
		await box.fs.mkdir('/home/user/app', { recursive: true });
		const r = await box.commands.run('expo start app --port 8082 --web -c');
		expect(r.exitCode).toBe(0);
		expect(r.stderr).toContain('expo → browser-metro');
		expect(calls).toEqual([{ name: 'browser-metro', args: ['app', '--port', '8082'] }]);
		box.destroy();
	});

	it('npx expo start and npm start ("expo start") reach the same command', async () => {
		const { box, calls } = await boxWithSpies();
		const r = await box.commands.run('npx expo start');
		expect(r.exitCode).toBe(0);
		expect(calls[0]).toEqual({ name: 'browser-metro', args: [] });
		box.destroy();
	});

	it('expo install is npm install; other subcommands explain themselves', async () => {
		const { box, calls } = await boxWithSpies();
		await box.commands.run('expo install expo-router react-native-svg');
		expect(calls[0]).toEqual({ name: 'npm', args: ['install', 'expo-router', 'react-native-svg'] });
		const r = await box.commands.run('expo prebuild');
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain('not available in a Lifo box');
		box.destroy();
	});
});

describe('browser-metro', () => {
	it('uses the project dir it is given', async () => {
		const box = await Sandbox.create();
		const r = await box.commands.run('cd /tmp && browser-metro /home/user/missing');
		expect(r.stderr).toContain('no such directory: /home/user/missing');
		box.destroy();
	});
});

describe('supabase in a box', () => {
	it('defaults tinbase (which `supabase` runs) to the pg-mem engine', async () => {
		const box = await Sandbox.create();
		expect((await box.commands.run('echo $TINBASE_ENGINE')).stdout.trim()).toBe('pgmem');
		const own = await Sandbox.create({ env: { TINBASE_ENGINE: 'wasm' } });
		expect((await own.commands.run('echo $TINBASE_ENGINE')).stdout.trim()).toBe('wasm');
		box.destroy();
		own.destroy();
	});
});
