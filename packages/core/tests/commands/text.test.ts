import { describe, it, expect, beforeEach } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';
import type { CommandContext, CommandOutputStream, CommandInputStream } from '../../src/commands/types.js';

function createContext(
  vfs: VFS,
  args: string[],
  cwd = '/',
  stdin?: string,
): CommandContext & { stdout: CommandOutputStream & { text: string }; stderr: CommandOutputStream & { text: string } } {
  const stdout = { text: '', write(t: string) { this.text += t; } };
  const stderr = { text: '', write(t: string) { this.text += t; } };
  const stdinStream: CommandInputStream | undefined = stdin !== undefined
    ? { read: async () => null, readAll: async () => stdin }
    : undefined;
  return {
    args,
    env: { HOME: '/home/user', USER: 'user' },
    cwd,
    vfs,
    stdout,
    stderr,
    signal: new AbortController().signal,
    stdin: stdinStream,
  };
}

describe('grep', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/test.txt', 'hello world\nfoo bar\nhello there\n');
  });

  it('finds matching lines', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['hello', '/test.txt']);
    const code = await grep(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('hello world\nhello there\n');
  });

  it('case insensitive with -i', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['-i', 'HELLO', '/test.txt']);
    const code = await grep(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('hello world');
  });

  it('inverts match with -v', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['-v', 'hello', '/test.txt']);
    const code = await grep(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('foo bar\n');
  });

  it('shows line numbers with -n', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['-n', 'hello', '/test.txt']);
    const code = await grep(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('1:hello world');
    expect(ctx.stdout.text).toContain('3:hello there');
  });

  it('counts matches with -c', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['-c', 'hello', '/test.txt']);
    const code = await grep(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('2\n');
  });

  it('returns 1 when no match', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['nonexistent', '/test.txt']);
    const code = await grep(ctx);
    expect(code).toBe(1);
  });

  it('reads from stdin', async () => {
    const { default: grep } = await import('../../src/commands/text/grep.js');
    const ctx = createContext(vfs, ['hello'], '/', 'hello world\nbye\n');
    const code = await grep(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('hello world\n');
  });
});

describe('head', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    vfs.writeFile('/lines.txt', lines);
  });

  it('shows first 10 lines by default', async () => {
    const { default: head } = await import('../../src/commands/text/head.js');
    const ctx = createContext(vfs, ['/lines.txt']);
    const code = await head(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('line 1');
    expect(ctx.stdout.text).toContain('line 10');
    expect(ctx.stdout.text).not.toContain('line 11');
  });

  it('shows first N lines with -n', async () => {
    const { default: head } = await import('../../src/commands/text/head.js');
    const ctx = createContext(vfs, ['-n', '5', '/lines.txt']);
    const code = await head(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('line 5');
    expect(ctx.stdout.text).not.toContain('line 6');
  });

  it('handles files with fewer than N lines', async () => {
    vfs.writeFile('/short.txt', 'one\ntwo\n');
    const { default: head } = await import('../../src/commands/text/head.js');
    const ctx = createContext(vfs, ['/short.txt']);
    const code = await head(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('one');
    expect(ctx.stdout.text).toContain('two');
  });
});

describe('tail', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    vfs.writeFile('/lines.txt', lines);
  });

  it('shows last 10 lines by default', async () => {
    const { default: tail } = await import('../../src/commands/text/tail.js');
    const ctx = createContext(vfs, ['/lines.txt']);
    const code = await tail(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('line 11');
    expect(ctx.stdout.text).toContain('line 20');
    expect(ctx.stdout.text).not.toContain('line 10\n');
  });

  it('shows last N lines with -n', async () => {
    const { default: tail } = await import('../../src/commands/text/tail.js');
    const ctx = createContext(vfs, ['-n', '3', '/lines.txt']);
    const code = await tail(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('line 18');
    expect(ctx.stdout.text).toContain('line 20');
  });
});

describe('wc', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/test.txt', 'hello world\nfoo bar baz\n');
  });

  it('counts lines, words, bytes', async () => {
    const { default: wc } = await import('../../src/commands/text/wc.js');
    const ctx = createContext(vfs, ['/test.txt']);
    const code = await wc(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('2'); // 2 lines
    expect(ctx.stdout.text).toContain('5'); // 5 words
  });

  it('counts lines only with -l', async () => {
    const { default: wc } = await import('../../src/commands/text/wc.js');
    const ctx = createContext(vfs, ['-l', '/test.txt']);
    const code = await wc(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('2');
  });

  it('reads from stdin', async () => {
    const { default: wc } = await import('../../src/commands/text/wc.js');
    const ctx = createContext(vfs, ['-w'], '/', 'one two three\n');
    const code = await wc(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('3');
  });
});

describe('sort', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/unsorted.txt', 'banana\napple\ncherry\n');
  });

  it('sorts alphabetically', async () => {
    const { default: sort } = await import('../../src/commands/text/sort.js');
    const ctx = createContext(vfs, ['/unsorted.txt']);
    const code = await sort(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('apple\nbanana\ncherry\n');
  });

  it('sorts in reverse with -r', async () => {
    const { default: sort } = await import('../../src/commands/text/sort.js');
    const ctx = createContext(vfs, ['-r', '/unsorted.txt']);
    const code = await sort(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('cherry\nbanana\napple\n');
  });

  it('sorts numerically with -n', async () => {
    const { default: sort } = await import('../../src/commands/text/sort.js');
    vfs.writeFile('/nums.txt', '10\n2\n30\n1\n');
    const ctx = createContext(vfs, ['-n', '/nums.txt']);
    const code = await sort(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('1\n2\n10\n30\n');
  });

  it('removes duplicates with -u', async () => {
    const { default: sort } = await import('../../src/commands/text/sort.js');
    vfs.writeFile('/dups.txt', 'a\nb\na\nb\nc\n');
    const ctx = createContext(vfs, ['-u', '/dups.txt']);
    const code = await sort(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('a\nb\nc\n');
  });
});

describe('uniq', () => {
  it('removes adjacent duplicates', async () => {
    const vfs = new VFS();
    const { default: uniq } = await import('../../src/commands/text/uniq.js');
    const ctx = createContext(vfs, [], '/', 'a\na\nb\nb\nc\n');
    const code = await uniq(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('a\nb\nc\n');
  });

  it('counts with -c', async () => {
    const vfs = new VFS();
    const { default: uniq } = await import('../../src/commands/text/uniq.js');
    const ctx = createContext(vfs, ['-c'], '/', 'a\na\nb\n');
    const code = await uniq(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('2 a');
    expect(ctx.stdout.text).toContain('1 b');
  });

  it('shows only duplicates with -d', async () => {
    const vfs = new VFS();
    const { default: uniq } = await import('../../src/commands/text/uniq.js');
    const ctx = createContext(vfs, ['-d'], '/', 'a\na\nb\nc\nc\n');
    const code = await uniq(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('a\nc\n');
  });
});

describe('cut', () => {
  it('extracts fields with -f and -d', async () => {
    const vfs = new VFS();
    const { default: cut } = await import('../../src/commands/text/cut.js');
    const ctx = createContext(vfs, ['-d', ':', '-f', '1'], '/', 'root:x:0\nuser:x:1000\n');
    const code = await cut(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('root\nuser\n');
  });

  it('extracts multiple fields', async () => {
    const vfs = new VFS();
    const { default: cut } = await import('../../src/commands/text/cut.js');
    const ctx = createContext(vfs, ['-d', ':', '-f', '1,3'], '/', 'root:x:0\nuser:x:1000\n');
    const code = await cut(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('root:0\nuser:1000\n');
  });
});

describe('tr', () => {
  it('translates characters', async () => {
    const vfs = new VFS();
    const { default: tr } = await import('../../src/commands/text/tr.js');
    const ctx = createContext(vfs, ['a-z', 'A-Z'], '/', 'hello');
    const code = await tr(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('HELLO');
  });

  it('deletes characters with -d', async () => {
    const vfs = new VFS();
    const { default: tr } = await import('../../src/commands/text/tr.js');
    const ctx = createContext(vfs, ['-d', 'aeiou'], '/', 'hello world');
    const code = await tr(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('hll wrld');
  });

  it('squeezes with -s', async () => {
    const vfs = new VFS();
    const { default: tr } = await import('../../src/commands/text/tr.js');
    const ctx = createContext(vfs, ['-s', ' '], '/', 'hello   world');
    const code = await tr(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('hello world');
  });
});

describe('tr (GNU semantics)', () => {
  async function tr(args: string[], stdin: string) {
    const { default: cmd } = await import('../../src/commands/text/tr.js');
    const ctx = createContext(new VFS(), args, '/', stdin);
    const code = await cmd(ctx);
    return { code, out: ctx.stdout.text, err: ctx.stderr.text };
  }

  it('-cd keeps only [:print:] and newline', async () => {
    expect((await tr(['-cd', '[:print:]\\n'], 'Ab c\x01\td!\n')).out).toBe('Ab cd!\n');
  });

  it('maps [:lower:] to [:upper:] and back', async () => {
    expect((await tr(['[:lower:]', '[:upper:]'], 'Hello')).out).toBe('HELLO');
    expect((await tr(['[:upper:][:lower:]', '[:lower:][:upper:]'], 'aBc')).out).toBe('AbC');
  });

  it('deletes classes', async () => {
    expect((await tr(['-d', '[:space:]'], 'a b\tc\n')).out).toBe('abc');
    expect((await tr(['-d', '[:digit:][:punct:]'], 'a1,b2!')).out).toBe('ab');
  });

  it('-cs squeezes the complement into one separator', async () => {
    expect((await tr(['-cs', '[:alnum:]', '\\n'], 'one, two;  three')).out).toBe('one\ntwo\nthree');
  });

  it('-c translates the complement', async () => {
    expect((await tr(['-c', 'a-z\\n', '_'], 'ab C!\n')).out).toBe('ab___\n');
  });

  it('pads SET2 with its last char, and -t truncates SET1', async () => {
    expect((await tr(['abc', 'x'], 'aabbcc')).out).toBe('xxxxxx');
    expect((await tr(['-t', 'abc', 'xy'], 'abc')).out).toBe('xyc');
    expect((await tr(['a-z', '[X*]'], 'hello')).out).toBe('XXXXX');
  });

  it('handles escapes, octal and escaped ranges', async () => {
    expect((await tr(['\\n', ' '], 'a\nb\n')).out).toBe('a b ');
    expect((await tr(['\\101', 'z'], 'ABA')).out).toBe('zBz');
    expect((await tr(['-d', '\\000-\\037'], 'a\x01b\x1f')).out).toBe('ab');
    expect((await tr(['\\\\', '/'], 'a\\b')).out).toBe('a/b');
  });

  it('-ds deletes SET1 then squeezes SET2', async () => {
    expect((await tr(['-ds', 'a', 'b'], 'aabbbcc')).out).toBe('bcc');
  });

  it('-s with translation squeezes the translated chars', async () => {
    expect((await tr(['-s', 'a-z', 'A-Z'], 'aabbc')).out).toBe('ABC');
  });

  it('rejects an unknown class', async () => {
    const r = await tr(['-d', '[:nope:]'], 'x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('invalid character class');
  });
});

describe('awk expressions', () => {
  async function awk(args: string[], stdin = '', vfs = new VFS()) {
    const { default: cmd } = await import('../../src/commands/text/awk.js');
    const ctx = createContext(vfs, args, '/', stdin);
    const code = await cmd(ctx);
    return { code, out: ctx.stdout.text, err: ctx.stderr.text };
  }

  it('ternary in print arguments', async () => {
    expect((await awk(['{print NR==1 ? "first" : "rest"}'], 'a\nb\n')).out).toBe('first\nrest\n');
    expect((await awk(['{print ($1 > 2 ? "big" : "small")}'], '1\n3\n')).out).toBe('small\nbig\n');
  });

  it('ternary in an assignment', async () => {
    expect((await awk(['{x = $1 > 2 ? "big" : "small"; print x}'], '1\n3\n')).out).toBe('small\nbig\n');
    expect((await awk(['{ s += $1 > 1 ? $1 : 0 } END { print s }'], '1\n2\n3\n')).out).toBe('5\n');
  });

  it('nested ternary is right-associative', async () => {
    expect((await awk(['{print $1 < 0 ? "neg" : $1 == 0 ? "zero" : "pos"}'], '-1\n0\n5\n')).out).toBe('neg\nzero\npos\n');
    expect((await awk(['{print "n=" ($1 % 2 ? "odd" : "even")}'], '3\n4\n')).out).toBe('n=odd\nn=even\n');
  });

  it('expression patterns, if/else and loops', async () => {
    expect((await awk(['NR==2'], 'a\nb\nc\n')).out).toBe('b\n');
    expect((await awk(['$2 > 10 {print $1}'], 'x 5\ny 20\n')).out).toBe('y\n');
    expect((await awk(['{if ($1 > 1) print "y"; else print "n"}'], '1\n2\n')).out).toBe('n\ny\n');
    expect((await awk(['BEGIN{i=0; while(i<3){printf "%d", i; i++}; print ""}'])).out).toBe('012\n');
    expect((await awk(['BEGIN{for(i=1;i<=3;i++) s = s i; print s}'])).out).toBe('123\n');
    expect((await awk(['/b/,/c/'], 'a\nb\nx\nc\nd\n')).out).toBe('b\nx\nc\n');
  });

  it('printf, builtins and number output', async () => {
    expect((await awk(['{printf "%-5s|%3d|%.2f\\n", $1, $2, $3}'], 'ab 7 3.14159\n')).out).toBe('ab   |  7|3.14\n');
    expect((await awk(['{print toupper(substr($1,2,3)), length, index($1,"c")}'], 'abcdef\n')).out).toBe('BCD 6 3\n');
    expect((await awk(['{gsub(/o/,"0"); print}'], 'foo boo\n')).out).toBe('f00 b00\n');
    expect((await awk(['BEGIN{print 1/3, 10/2, 2^10}'])).out).toBe('0.333333 5 1024\n');
    expect((await awk(['{print x "|" $5 "|"}'], 'a\n')).out).toBe('||\n');
  });

  it('-v, FS in BEGIN, OFS and field assignment', async () => {
    expect((await awk(['-v', 'n=3', 'BEGIN{print n*2}'])).out).toBe('6\n');
    expect((await awk(['BEGIN{FS=":"}{print $2}'], 'a:b:c\n')).out).toBe('b\n');
    expect((await awk(['BEGIN{OFS="-"}{$2="X"; print}'], 'a b c\n')).out).toBe('a-X-c\n');
  });

  it('print > file writes to the VFS', async () => {
    const vfs = new VFS();
    const r = await awk(['{print $1 > "/out.txt"}'], 'a 1\nb 2\n', vfs);
    expect(r.code).toBe(0);
    expect(vfs.readFileString('/out.txt')).toBe('a\nb\n');
  });

  it('prints nothing for empty input', async () => {
    expect((await awk(['{print}'], '')).out).toBe('');
  });

  it('reports unsupported features instead of mis-evaluating', async () => {
    const r = await awk(['{a[$1]++}'], 'x\n');
    expect(r.code).toBe(2);
    expect(r.err).toContain('arrays');
  });
});

describe('sed', () => {
  let vfs: VFS;

  beforeEach(() => {
    vfs = new VFS();
    vfs.writeFile('/test.txt', 'hello world\nfoo bar\n');
  });

  it('substitutes first match', async () => {
    const { default: sed } = await import('../../src/commands/text/sed.js');
    const ctx = createContext(vfs, ['s/hello/hi/', '/test.txt']);
    const code = await sed(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toContain('hi world');
  });

  it('substitutes globally with g flag', async () => {
    vfs.writeFile('/rep.txt', 'aaa bbb aaa\n');
    const { default: sed } = await import('../../src/commands/text/sed.js');
    const ctx = createContext(vfs, ['s/aaa/xxx/g', '/rep.txt']);
    const code = await sed(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('xxx bbb xxx\n');
  });

  it('modifies file in place with -i', async () => {
    const { default: sed } = await import('../../src/commands/text/sed.js');
    const ctx = createContext(vfs, ['-i', 's/hello/hi/', '/test.txt']);
    const code = await sed(ctx);
    expect(code).toBe(0);
    expect(vfs.readFileString('/test.txt')).toContain('hi world');
  });
});

describe('sed BRE/ERE translation', () => {
  async function run(args: string[], stdin: string) {
    const { default: sed } = await import('../../src/commands/text/sed.js');
    const ctx = createContext(new VFS(), args, '/', stdin);
    const code = await sed(ctx);
    return { code, out: ctx.stdout.text, err: ctx.stderr.text };
  }

  it('treats an unescaped | as literal (customer repro)', async () => {
    const r = await run(['s/^xx|/X/'], 'xx|| yy\n');
    expect(r.code).toBe(0);
    expect(r.out).toBe('X| yy\n');
  });

  it('matches a literal | at the start of the line', async () => {
    expect((await run(['s/^|| //'], '|| \'Day Package\',\n')).out).toBe("'Day Package',\n");
  });

  it('matches a literal | in the middle', async () => {
    expect((await run(['s/a|b/X/g'], 'a|b ab a|b\n')).out).toBe('X ab X\n');
  });

  it('treats \\| as alternation in BRE', async () => {
    expect((await run(['s/cat\\|dog/pet/g'], 'cat dog cow\n')).out).toBe('pet pet cow\n');
  });

  it('supports \\( \\) groups with \\1 and & in the replacement', async () => {
    expect((await run(['s/\\(foo\\)\\(bar\\)/\\2\\1 [&]/'], 'foobar\n')).out).toBe('barfoo [foobar]\n');
  });

  it('treats unescaped ( ) as literal in BRE', async () => {
    expect((await run(['s/f(x)/g/'], 'y = f(x)\n')).out).toBe('y = g\n');
  });

  it('treats unescaped + ? { } as literal in BRE', async () => {
    expect((await run(['s/a+b?/X/'], 'a+b? ab\n')).out).toBe('X ab\n');
    expect((await run(['s/{x}/Y/'], 'o{x}o\n')).out).toBe('oYo\n');
  });

  it('treats \\+ \\? \\{n\\} as operators in BRE', async () => {
    expect((await run(['s/a\\+/X/'], 'baaac\n')).out).toBe('bXc\n');
    expect((await run(['s/colou\\?r/C/g'], 'color colour\n')).out).toBe('C C\n');
    expect((await run(['s/a\\{2\\}/X/'], 'aaa\n')).out).toBe('Xa\n');
  });

  it('keeps | literal inside a bracket expression', async () => {
    expect((await run(['s/[|,]/;/g'], 'a|b,c\n')).out).toBe('a;b;c\n');
    expect((await run(['-E', 's/[|]+/;/g'], 'a||b\n')).out).toBe('a;b\n');
  });

  it('supports POSIX classes in bracket expressions', async () => {
    expect((await run(['s/[[:space:]]\\+$//'], 'trail   \n')).out).toBe('trail\n');
    expect((await run(['s/[^[:alnum:]]//g'], 'a-b_c!1\n')).out).toBe('abc1\n');
  });

  it('treats a leading * and a non-initial ^ / non-final $ literally in BRE', async () => {
    expect((await run(['s/*x/Y/'], 'a*x\n')).out).toBe('aY\n');
    expect((await run(['s/a^b$c/Z/'], 'a^b$c\n')).out).toBe('Z\n');
  });

  it('keeps -E/-r semantics: unescaped operators special, escaped literal', async () => {
    expect((await run(['-E', 's/cat|dog/pet/g'], 'cat dog\n')).out).toBe('pet pet\n');
    expect((await run(['-r', 's/(a+)(b?)/<\\1|\\2>/'], 'aab\n')).out).toBe('<aa|b>\n');
    expect((await run(['-E', 's/a\\|b/X/'], 'a|b\n')).out).toBe('X\n');
    expect((await run(['-E', 's/x{2}/Y/'], 'xxx\n')).out).toBe('Yx\n');
  });

  it('treats an escaped delimiter as that literal character', async () => {
    expect((await run(['s|a\\|b|X|'], 'a|b\n')).out).toBe('X\n');
    expect((await run(['s/\\/usr\\/bin/BIN/'], '/usr/bin/env\n')).out).toBe('BIN/env\n');
  });

  it('applies BRE rules to /regex/ addresses', async () => {
    expect((await run(['-n', '/^||/p'], 'a\n|| b\nc\n')).out).toBe('|| b\n');
  });

  it('supports the GNU addr,+N address form', async () => {
    const input = Array.from({ length: 60 }, (_, k) => `L${k + 1}`).join('\n') + '\n';
    const r = await run(['-n', '33,+20p'], input);
    expect(r.code).toBe(0);
    expect(r.out).toBe(Array.from({ length: 21 }, (_, k) => `L${k + 33}`).join('\n') + '\n');
    expect((await run(['/^b/,+1d'], 'a\nb\nc\nd\nb\ne\n')).out).toBe('a\nd\n');
    expect((await run(['-n', '2,+0p'], 'a\nb\nc\n')).out).toBe('b\n');
  });
});

describe('awk', () => {
  it('prints specific field', async () => {
    const vfs = new VFS();
    const { default: awk } = await import('../../src/commands/text/awk.js');
    const ctx = createContext(vfs, ['{print $1}'], '/', 'hello world\nfoo bar\n');
    const code = await awk(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('hello\nfoo\n');
  });

  it('uses custom field separator with -F', async () => {
    const vfs = new VFS();
    const { default: awk } = await import('../../src/commands/text/awk.js');
    const ctx = createContext(vfs, ['-F', ':', '{print $1}'], '/', 'root:x:0\nuser:x:1000\n');
    const code = await awk(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('root\nuser\n');
  });

  it('supports NR variable', async () => {
    const vfs = new VFS();
    const { default: awk } = await import('../../src/commands/text/awk.js');
    const ctx = createContext(vfs, ['{print NR, $0}'], '/', 'a\nb\nc\n');
    const code = await awk(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout.text).toBe('1 a\n2 b\n3 c\n');
  });
});
