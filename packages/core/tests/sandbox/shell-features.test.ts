import { describe, expect, it } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { needsMoreInput } from '../../src/shell/parser.js';

const out = async (box: Sandbox, cmd: string) => (await box.commands.run(cmd)).stdout;

describe('brace expansion', () => {
	it('expands lists, ranges and nesting', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'echo {a,b,c}')).toBe('a b c\n');
		expect(await out(box, 'echo file{1,2}.txt')).toBe('file1.txt file2.txt\n');
		expect(await out(box, 'echo {1..5}')).toBe('1 2 3 4 5\n');
		expect(await out(box, 'echo {5..1}')).toBe('5 4 3 2 1\n');
		expect(await out(box, 'echo {01..10..3}')).toBe('01 04 07 10\n');
		expect(await out(box, 'echo {a..e}')).toBe('a b c d e\n');
		expect(await out(box, 'echo x{a,b{c,d}}y')).toBe('xay xbcy xbdy\n');
		expect(await out(box, 'echo {a,b}{1,2}')).toBe('a1 a2 b1 b2\n');
	});

	it('leaves quoted, escaped and non-expanding braces alone', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'echo "{a,b}"')).toBe('{a,b}\n');
		expect(await out(box, "echo '{1..3}'")).toBe('{1..3}\n');
		expect(await out(box, 'echo \\{a,b\\}')).toBe('{a,b}\n');
		expect(await out(box, 'echo {} {x}')).toBe('{} {x}\n');
		expect(await out(box, 'X=hi; echo ${X}{1,2}')).toBe('hi1 hi2\n');
	});

	it('makes directories with mkdir -p', async () => {
		const box = await Sandbox.create();
		await box.commands.run('mkdir -p /tmp/p/{src,test}/{a,b}');
		expect(await out(box, 'ls /tmp/p/src')).toBe('a\nb\n');
		expect(await out(box, 'for d in {1..3}; do echo d$d; done')).toBe('d1\nd2\nd3\n');
	});
});

describe('subshells', () => {
	it('keeps cd, variables and functions inside', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'cd /tmp; (cd /; pwd); pwd')).toBe('/\n/tmp\n');
		expect(await out(box, 'X=1; (X=2; echo $X); echo $X')).toBe('2\n1\n');
		expect(await out(box, '(export SUB=yes); echo "[$SUB]"')).toBe('[]\n');
		expect(await out(box, '(f() { echo f; }; f); f 2>/dev/null || echo gone')).toBe('f\ngone\n');
	});

	it('captures output in pipes, substitutions and redirects', async () => {
		const box = await Sandbox.create();
		expect(await out(box, '(echo b; echo a) | sort')).toBe('a\nb\n');
		expect(await out(box, 'X=$(echo in; echo sub); echo "$X"')).toBe('in\nsub\n');
		expect(await out(box, '(echo one; echo two) > /tmp/sub.txt; cat /tmp/sub.txt')).toBe('one\ntwo\n');
	});

	it('exit ends only the subshell, with its code', async () => {
		const box = await Sandbox.create();
		const r = await box.commands.run('(exit 3); echo "code $?"');
		expect(r.stdout).toBe('code 3\n');
	});
});

describe('here-documents and here-strings', () => {
	it('feeds a here-doc with expansion', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'NAME=lifo\ncat <<EOF\nhello $NAME\n$(echo sub)\nEOF')).toBe('hello lifo\nsub\n');
		expect(await out(box, 'cat <<EOF | tr a-z A-Z\nabc\nEOF\necho after')).toBe('ABC\nafter\n');
	});

	it('quoted delimiters disable expansion; <<- strips tabs; escapes', async () => {
		const box = await Sandbox.create();
		expect(await out(box, "cat <<'EOF'\n$HOME and $(nope)\nEOF")).toBe('$HOME and $(nope)\n');
		expect(await out(box, 'cat <<-END\n\t\tindented\n\tEND')).toBe('indented\n');
		expect(await out(box, 'X=1; cat <<EOF\n\\$X is $X\nEOF')).toBe('$X is 1\n');
	});

	it('writes a file with cat > file <<EOF', async () => {
		const box = await Sandbox.create();
		await box.commands.run('cat > /tmp/conf.json <<EOF\n{"port": 3000}\nEOF');
		expect(await box.fs.readFile('/tmp/conf.json')).toBe('{"port": 3000}\n');
	});

	it('here-strings', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'X=world; cat <<< "hello $X"')).toBe('hello world\n');
		expect(await out(box, 'wc -w <<< "one two three"')).toMatch(/3/);
	});
});

describe('$$ and $!', () => {
	it('$$ is a stable number for the shell', async () => {
		const box = await Sandbox.create();
		const a = (await out(box, 'echo $$')).trim();
		expect(a).toMatch(/^\d+$/);
		expect((await out(box, 'echo "$$"')).trim()).toBe(a);
		expect((await out(box, 'echo $(echo $$)')).trim()).toBe(a);
	});
});

describe('read', () => {
	it('reads lines from a pipe in a while loop', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'printf "a\\nb\\nc\\n" | while read line; do echo "<$line>"; done')).toBe('<a>\n<b>\n<c>\n');
	});

	it('splits fields on IFS, the last name takes the rest', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'echo "one two three four" | { read a b rest; echo "$a|$b|$rest"; }')).toBe('one|two|three four\n');
		expect(await out(box, 'echo "x:y:z" | { IFS=: read a b c; echo "$a $b $c"; }')).toBe('x y z\n');
		expect(await out(box, 'echo "  padded  " | { read v; echo "[$v]"; }')).toBe('[padded]\n');
	});

	it('uses REPLY, handles -r, and returns 1 at EOF', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'echo hi | { read; echo "$REPLY"; }')).toBe('hi\n');
		expect(await out(box, "printf 'a\\\\tb\\n' | { read -r v; echo \"$v\"; }")).toBe('a\\tb\n');
		expect(await out(box, 'printf "" | { read v; echo "code $?"; }')).toBe('code 1\n');
		// A last line without a newline is still read, with status 1.
		expect(await out(box, 'printf "x\\ny" | while read l || [ -n "$l" ]; do echo "$l"; done')).toBe('x\ny\n');
	});

	it('reads from here-docs, files and commands.run stdin', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'while read k v; do echo "$k=$v"; done <<EOF\na 1\nb 2\nEOF')).toBe('a=1\nb=2\n');
		await box.fs.writeFile('/tmp/lines.txt', 'l1\nl2\n');
		expect(await out(box, 'while read l; do echo "-$l"; done < /tmp/lines.txt')).toBe('-l1\n-l2\n');
		expect((await box.commands.run('read name; echo "hi $name"', { stdin: 'ada\n' })).stdout).toBe('hi ada\n');
	});

	it('-p writes the prompt to stderr', async () => {
		const box = await Sandbox.create();
		const r = await box.commands.run('read -p "Name? " n; echo "$n"', { stdin: 'z\n' });
		expect(r.stderr).toBe('Name? ');
		expect(r.stdout).toBe('z\n');
	});
});

describe('compound redirections', () => {
	it('applies > and < to loops and groups', async () => {
		const box = await Sandbox.create();
		await box.commands.run('for i in 1 2; do echo $i; done > /tmp/loop.txt');
		expect(await box.fs.readFile('/tmp/loop.txt')).toBe('1\n2\n');
		await box.commands.run('{ echo a; echo b >&2; } 2> /tmp/err.txt > /tmp/out.txt');
		expect(await box.fs.readFile('/tmp/out.txt')).toBe('a\n');
		expect(await box.fs.readFile('/tmp/err.txt')).toBe('b\n');
	});
});

describe('escapes', () => {
	it('a backslash makes the next character literal', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'X=1; echo \\$X')).toBe('$X\n');
		expect(await out(box, 'echo a\\ b')).toBe('a b\n');
		expect(await out(box, 'echo one \\\ntwo')).toBe('one two\n');
	});
});

describe('needsMoreInput', () => {
	it('detects unfinished commands', () => {
		expect(needsMoreInput('if true; then')).toBe(true);
		expect(needsMoreInput('for i in 1 2; do echo $i')).toBe(true);
		expect(needsMoreInput('cat <<EOF\nabc')).toBe(true);
		expect(needsMoreInput('echo "abc')).toBe(true);
		expect(needsMoreInput('ls |')).toBe(true);
		expect(needsMoreInput('echo a \\')).toBe(true);
		expect(needsMoreInput('(cd /tmp')).toBe(true);
		expect(needsMoreInput('echo done')).toBe(false);
		expect(needsMoreInput('cat <<EOF\nabc\nEOF')).toBe(false);
		expect(needsMoreInput('if true; then echo y; fi')).toBe(false);
		expect(needsMoreInput("echo 'it''s'")).toBe(false);
	});
});

describe('commands.run env', () => {
	it('scopes the env overlay to that one command', async () => {
		const box = await Sandbox.create({ env: { KEEP: 'base' } });
		expect((await box.commands.run('echo "$LEAKY $KEEP"', { env: { LEAKY: 'yes', KEEP: 'over' } })).stdout).toBe('yes over\n');
		expect((await box.commands.run('echo "[$LEAKY] $KEEP"')).stdout).toBe('[] base\n');
		expect(box.env.LEAKY).toBeUndefined();
	});
});

describe('more builtins', () => {
	it('local scopes a variable to the function call', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'x=outer; f() { local x=inner; echo $x; }; f; echo $x')).toBe('inner\nouter\n');
		expect((await box.commands.run('local y=1')).exitCode).toBe(1);
	});

	it('shift and set -- manage positional parameters', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'set -- a b c; echo "$# $1"; shift; echo "$# $1 $@"')).toBe('3 a\n2 b b c\n');
		expect(await out(box, 'f() { while [ $# -gt 0 ]; do echo "arg $1"; shift; done; }; f x y')).toBe('arg x\narg y\n');
		expect((await box.commands.run('set -euo pipefail; echo ok')).stdout).toBe('ok\n');
	});

	it('command -v and type find builtins, functions and commands', async () => {
		const box = await Sandbox.create();
		expect(await out(box, 'command -v ls; command -v cd')).toBe('/usr/bin/ls\ncd\n');
		expect((await box.commands.run('command -v nope')).exitCode).toBe(1);
		expect(await out(box, 'if command -v git >/dev/null 2>&1; then echo has; else echo no; fi')).toMatch(/has|no/);
		expect(await out(box, 'f() { :; }; type f; type read; type ls')).toBe('f is a function\nread is a shell builtin\nls is /usr/bin/ls\n');
		expect(await out(box, 'echo() { printf "fn\\n"; }; command echo real')).toBe('real\n');
	});

	it('$RANDOM is a number', async () => {
		const box = await Sandbox.create();
		expect((await out(box, 'echo $RANDOM')).trim()).toMatch(/^\d+$/);
	});

	it('help lists only registered commands, with packages under Other', async () => {
		const box = await Sandbox.create();
		box.commands.register('mytool', async () => 0);
		const help = await out(box, 'help');
		expect(help).not.toMatch(/\bcal\b|\bbc\b|\bman\b/);
		expect(help).toMatch(/Other commands:[\s\S]*mytool/);
		expect(help).toContain('read');
	});

	it('ls writes one name per line into pipes and captures', async () => {
		const box = await Sandbox.create();
		await box.commands.run('mkdir -p /tmp/l && touch /tmp/l/a /tmp/l/b /tmp/l/c');
		expect(await out(box, 'ls /tmp/l | wc -l')).toMatch(/^\s*3\s*$/);
		expect(await out(box, 'ls /tmp/l')).toBe('a\nb\nc\n');
	});
});

describe('npm scripts', () => {
	it('runs pre and post scripts, and passes extra arguments', async () => {
		const box = await Sandbox.create();
		await box.fs.mkdir('/home/user/p', { recursive: true });
		await box.fs.writeFile('/home/user/p/package.json', JSON.stringify({
			name: 'p',
			version: '1.0.0',
			scripts: {
				prebuild: 'echo PRE',
				build: 'echo BUILD',
				postbuild: 'echo POST',
				pretest: 'echo PRETEST',
				test: 'echo TEST',
				fail: 'exit 3',
				postfail: 'echo SHOULD-NOT-RUN',
				args: 'echo got',
			},
		}));
		const build = await box.commands.run('cd /home/user/p && npm run build');
		expect(build.stdout.match(/^(PRE|BUILD|POST)$/gm)).toEqual(['PRE', 'BUILD', 'POST']);
		const test = await box.commands.run('cd /home/user/p && npm test');
		expect(test.stdout.match(/^(PRETEST|TEST)$/gm)).toEqual(['PRETEST', 'TEST']);
		const fail = await box.commands.run('cd /home/user/p && npm run fail');
		expect(fail.exitCode).not.toBe(0);
		expect(fail.stdout).not.toContain('SHOULD-NOT-RUN');
		const args = await box.commands.run('cd /home/user/p && npm run args -- --flag "two words"');
		expect(args.stdout).toMatch(/^got --flag two words$/m);
	});
});
