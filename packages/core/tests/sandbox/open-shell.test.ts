import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import type { ITerminal } from '../../src/terminal/ITerminal.js';

/** A terminal the test types into; output collects in `out`. */
function fakeTerminal() {
	let input: (d: string) => void = () => {};
	const t = {
		out: '',
		cols: 90,
		rows: 20,
		write(d: string) {
			t.out += d;
		},
		writeln(d: string) {
			t.out += d + '\r\n';
		},
		onData(cb: (d: string) => void) {
			input = cb;
		},
		focus() {},
		clear() {},
		type(d: string) {
			input(d);
		},
		async until(text: string, ms = 5000) {
			const end = Date.now() + ms;
			while (!t.out.includes(text)) {
				if (Date.now() > end) throw new Error(`no "${text}" in ${JSON.stringify(t.out)}`);
				await new Promise((r) => setTimeout(r, 10));
			}
		},
	};
	return t satisfies ITerminal & Record<string, unknown>;
}

describe('box.openShell', () => {
	it('opens a second interactive shell on the same box, with its own cwd', async () => {
		const box = await Sandbox.create();
		await box.fs.mkdir('/home/user/app', { recursive: true });
		box.env.GREETING = 'hello';
		const t = fakeTerminal();
		const s = await box.openShell(t, { cwd: '/home/user/app' });
		await t.until('$');
		t.type('pwd; echo $GREETING; echo x > made-here.txt\r');
		await t.until('hello');
		expect(t.out).toContain('/home/user/app');
		await new Promise((r) => setTimeout(r, 50));
		expect(await box.fs.readFile('/home/user/app/made-here.txt')).toBe('x\n');
		// Its cd doesn't move the box's own shell.
		t.type('cd /tmp\r');
		await new Promise((r) => setTimeout(r, 50));
		expect(box.cwd).toBe('/home/user');
		s.dispose();
		box.destroy();
	});

	it('`exit` and Ctrl+D at an empty prompt end the session and call onExit', async () => {
		const box = await Sandbox.create();
		const codes: number[] = [];
		const t = fakeTerminal();
		await box.openShell(t, { onExit: (c) => codes.push(c) });
		await t.until('$');
		t.type('exit 3\r');
		await t.until('logout');
		await new Promise((r) => setTimeout(r, 20));
		expect(codes).toEqual([3]);
		// Input after the end is ignored.
		t.type('echo still-here\r');
		await new Promise((r) => setTimeout(r, 50));
		expect(t.out).not.toContain('still-here\r\n');

		const t2 = fakeTerminal();
		await box.openShell(t2, { onExit: (c) => codes.push(c) });
		await t2.until('$');
		t2.type('\x04');
		expect(codes).toEqual([3, 0]);
		box.destroy();
	});

	it('the page shell keeps today\'s exit (prints logout, keeps going)', async () => {
		const box = await Sandbox.create();
		const r = await box.commands.run('echo a');
		expect(r.stdout).toBe('a\n');
		const t = fakeTerminal();
		await box.attach(t);
		t.type('exit\r');
		await t.until('logout');
		t.type('echo after\r');
		await t.until('after\r\n');
		box.destroy();
	});
});
