import { describe, it, expect } from 'vitest';
import { Shell } from '../../src/shell/Shell.js';
import { VFS } from '../../src/kernel/vfs/index.js';
import { createDefaultRegistry } from '../../src/commands/registry.js';
import { ProcessRegistry } from '../../src/shell/ProcessRegistry.js';

// Typing a line that ends exactly at the right edge: terminals defer that wrap, so the shell has
// to force it, or its next redraw moves up a row too far and erases the previous output line.
describe('line editor at the right edge', () => {
	it('forces the deferred wrap when the input exactly fills the row', async () => {
		const out: string[] = [];
		let onData: (d: string) => void = () => {};
		const COLS = 30;
		const terminal = {
			write: (d: string) => out.push(d),
			writeln: (d: string) => out.push(d + '\n'),
			onData: (cb: (d: string) => void) => { onData = cb; },
			get cols() { return COLS; },
			get rows() { return 24; },
			focus() {},
			clear() {},
		};
		const vfs = new VFS();
		vfs.mkdir('/home/user', { recursive: true });
		const shell = new Shell(terminal as never, vfs, createDefaultRegistry(), { HOME: '/home/user', USER: 'u', HOSTNAME: 'h' }, new ProcessRegistry());
		shell.start();
		await new Promise((r) => setTimeout(r, 0));

		const promptWidth = 'u@h:~$ '.length;
		for (const ch of 'x'.repeat(COLS - promptWidth - 1)) onData(ch);
		out.length = 0;
		onData('y'); // now prompt + input == COLS exactly
		expect(out.join('')).toContain(' \b');
	});
});
