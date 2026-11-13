import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import type { ITerminal } from '../../src/terminal/ITerminal.js';

class FakeTerminal implements ITerminal {
	output = '';
	private cb: ((d: string) => void) | null = null;
	write(d: string) { this.output += d; }
	writeln(d: string) { this.output += d + '\r\n'; }
	onData(cb: (d: string) => void) { this.cb = cb; }
	type(d: string) { this.cb?.(d); }
	cols = 120;
	rows = 30;
	focus() {}
	clear() {}
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('Sandbox.attach', () => {
	it('connects a terminal to the shell of a headless box', async () => {
		const box = await Sandbox.create();
		await box.commands.run('export FROM_RUN=shared; cd /tmp');
		const term = new FakeTerminal();
		await box.attach(term);
		await settle();
		expect(term.output).toContain('$ ');
		term.type('echo "$FROM_RUN in $(pwd)"\r');
		await settle();
		expect(term.output).toContain('shared in /tmp');

		// Typed state is visible to commands.run, and the other way round.
		term.type('export TYPED=1\r');
		await settle();
		expect((await box.commands.run('echo $TYPED')).stdout).toBe('1\n');
	});

	it('moves to a new terminal and detaches', async () => {
		const box = await Sandbox.create();
		const a = new FakeTerminal();
		const b = new FakeTerminal();
		await box.attach(a);
		await box.attach(b);
		await settle();
		a.type('echo from-a\r');
		b.type('echo from-b\r');
		await settle();
		expect(a.output).not.toContain('\r\nfrom-a\r\n');
		expect(b.output).toContain('\r\nfrom-b\r\n');
		box.detach();
		b.type('echo after\r');
		await settle();
		expect(b.output).not.toContain('\r\nafter\r\n');
		expect((await box.commands.run('echo still')).stdout).toBe('still\n');
	});
});

describe('interactive multi-line commands', () => {
	it('shows "> " until the command is complete, then runs it', async () => {
		const box = await Sandbox.create();
		const term = new FakeTerminal();
		await box.attach(term);
		await settle();
		for (const key of 'for i in 1 2') term.type(key);
		term.type('\r');
		expect(term.output.endsWith('> ')).toBe(true);
		for (const key of 'do echo n$i; done') term.type(key);
		term.type('\r');
		await settle();
		expect(term.output).toContain('n1\r\nn2\r\n');
	});

	it('runs a pasted here-document', async () => {
		const box = await Sandbox.create();
		const term = new FakeTerminal();
		await box.attach(term);
		await settle();
		term.type('cat > /tmp/p.txt <<EOF\nline one\n\n  indented\nEOF\n');
		await settle();
		expect(await box.fs.readFile('/tmp/p.txt')).toBe('line one\n\n  indented\n');
	});
});
