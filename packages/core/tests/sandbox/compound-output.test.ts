import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

// Compound commands used to write their bodies' output to the terminal instead of
// to the stream they were given, so captured runs saw nothing.
describe('compound command output', () => {
	it('is captured by commands.run', async () => {
		const box = await Sandbox.create();
		expect((await box.commands.run('for i in 1 2; do echo line $i; done')).stdout).toBe('line 1\nline 2\n');
		expect((await box.commands.run('if true; then echo yes; fi')).stdout).toBe('yes\n');
		expect((await box.commands.run('i=0; while [ $i -lt 2 ]; do echo w$i; i=$((i+1)); done')).stdout).toBe('w0\nw1\n');
		expect((await box.commands.run('{ echo a; echo b; }')).stdout).toBe('a\nb\n');
	});

	it('flows through pipes and command substitution', async () => {
		const box = await Sandbox.create();
		expect((await box.commands.run('for i in 3 1 2; do echo $i; done | sort')).stdout).toBe('1\n2\n3\n');
		expect((await box.commands.run('X=$(for i in a b; do echo $i; done); echo "got $X"')).stdout).toBe('got a\nb\n');
	});

	it('streams to onStdout', async () => {
		const box = await Sandbox.create();
		let streamed = '';
		await box.commands.run('for i in 1 2; do echo $i; done', { onStdout: (d) => (streamed += d) });
		expect(streamed).toBe('1\n2\n');
	});

	it('includes output from shell functions, in pipes and substitutions', async () => {
		const box = await Sandbox.create();
		expect((await box.commands.run('greet() { echo "hello, $1"; }; greet x')).stdout).toBe('hello, x\n');
		expect((await box.commands.run('f() { echo in-f; }; f | tr a-z A-Z')).stdout).toBe('IN-F\n');
		expect((await box.commands.run('f() { echo a; }; X=$(f); echo "[$X]"')).stdout).toBe('[a]\n');
		expect((await box.commands.run('g() { echo "<$1>"; }; for n in b a; do g $n; done | sort')).stdout).toBe('<a>\n<b>\n');
	});
});
