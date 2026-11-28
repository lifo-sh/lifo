// bun and bunx in a box: Bun's CLI mapped onto Lifo's npm, npx and node (commands/system/bun.ts),
// and TypeScript/JSX files in node, which `bun <file>` relies on (node-compat/typescript.ts).
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';
import { parseDotEnv, BUN_VERSION } from '../../src/commands/system/bun.js';
import { stripJsonComments, jsxOptionsFromTsconfig } from '../../src/node-compat/typescript.js';

const APP = '/home/user/app';

async function box(files: Record<string, string>) {
	const b = await Sandbox.create({ persist: false });
	for (const [path, content] of Object.entries(files)) {
		const full = `${APP}/${path}`;
		await b.fs.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
		await b.fs.writeFile(full, content);
	}
	return b;
}

describe('TypeScript files in node', () => {
	it('strips types, compiles enums, and resolves imports TypeScript-style', async () => {
		const b = await box({
			'main.ts': [
				`import { greet, type Greeting } from './greet';`,
				`import { add } from './math.js';`,
				`enum Color { Red, Green }`,
				`interface Point { x: number; y: number }`,
				`const p: Point = { x: 1, y: 2 };`,
				`const g: Greeting = greet('box');`,
				`console.log(g, add(p.x, p.y), Color.Green, Color[0], (p as Point).x satisfies number);`,
			].join('\n'),
			'greet.ts': `export type Greeting = string;\nexport function greet(name: string): Greeting { return \`hi \${name}\`; }\n`,
			'math.ts': `export const add = (a: number, b: number): number => a + b;\n`,
		});
		const r = await b.commands.run(`cd ${APP} && node main.ts`);
		expect(r.stderr).toBe('');
		expect(r.stdout).toBe('hi box 3 1 Red 1\n');
	});

	it('runs .mts as an ES module and .tsx with the JSX factory from tsconfig.json', async () => {
		const b = await box({
			'esm.mts': `const n: number = await Promise.resolve(42);\nconsole.log(typeof require, n);\n`,
			'tsconfig.json': `{\n  // comments and trailing commas, as tsconfig allows\n  "compilerOptions": { "jsx": "react", "jsxFactory": "h", },\n}\n`,
			'view.tsx': `const h = (tag: string, props: object | null, ...kids: unknown[]) => \`<\${tag}>\${kids.join('')}</\${tag}>\`;\nconst name: string = 'box';\nconsole.log(<b>hi {name}</b>);\n`,
		});
		const esm = await b.commands.run(`cd ${APP} && node esm.mts`);
		expect(esm.stdout).toBe('function 42\n');
		const tsx = await b.commands.run(`cd ${APP} && node view.tsx`);
		expect(tsx.stderr).toBe('');
		expect(tsx.stdout).toBe('<b>hi box</b>\n');
	});

	it('reads tsconfig JSX options from JSONC', () => {
		expect(stripJsonComments('{"a": "x // not a comment", /* c */ "b": [1, 2,], }')).toBe('{"a": "x // not a comment",  "b": [1, 2] }');
		expect(jsxOptionsFromTsconfig('{"compilerOptions": {"jsx": "react-jsx", "jsxImportSource": "preact"}}')).toEqual({ importSource: 'preact' });
	});
});

describe('bun', () => {
	it('prints its version and help', async () => {
		const b = await box({});
		expect((await b.commands.run('bun --version')).stdout).toBe(`${BUN_VERSION}\n`);
		const help = await b.commands.run('bun --help');
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain('Usage: bun <command>');
	});

	it('runs a TypeScript file directly, with the .env files loaded and bun as the user agent', async () => {
		const b = await box({
			'index.ts': `const who: string = process.env.WHO ?? 'nobody';\nconsole.log(\`hello \${who}\`, process.env.LEVEL, process.env.npm_config_user_agent?.split(' ')[0], process.argv.slice(2).join(','));\n`,
			'.env': 'WHO=env\nLEVEL=base # a comment\n',
			'.env.local': 'WHO="local file"\n',
		});
		const r = await b.commands.run(`cd ${APP} && bun index.ts a b && LEVEL=shell bun run ./index`);
		expect(r.stdout).toBe(`hello local file base bun/${BUN_VERSION} a,b\nhello local file shell bun/${BUN_VERSION} \n`);
		expect(r.stderr).toContain("bun in a Lifo box runs on Lifo's npm and node");
	});

	it('runs package.json scripts with pre/post hooks, with or without `run`', async () => {
		const b = await box({
			'package.json': JSON.stringify({
				name: 'app',
				scripts: { prebuild: 'echo pre', build: 'echo build', postbuild: 'echo post', greet: 'node greet.js' },
			}),
			'greet.js': `console.log('greet', process.argv.slice(2).join(' '), process.env.npm_config_user_agent.startsWith('bun/'));\n`,
		});
		const run = await b.commands.run(`cd ${APP} && bun run build`);
		expect(run.stdout).toBe('pre\nbuild\npost\n');
		expect(run.stderr).toContain('$ echo build\n');
		const bare = await b.commands.run(`cd ${APP} && bun greet --loud`);
		expect(bare.stdout).toBe('greet --loud true\n');
		const missing = await b.commands.run(`cd ${APP} && bun nope`);
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr).toContain('error: Script not found "nope"');
		expect((await b.commands.run(`cd ${APP} && bun run --if-present nope`)).exitCode).toBe(0);
	});

	it('runs a command from node_modules with bun run and bunx', async () => {
		const b = await box({
			'package.json': JSON.stringify({ name: 'app' }),
			'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '5.9.3', bin: { tsc: './bin/tsc' } }),
			'node_modules/typescript/bin/tsc': `console.log('local tsc', process.argv.slice(2).join(' '));\n`,
		});
		expect((await b.commands.run(`cd ${APP} && bun run tsc --noEmit`)).stdout).toBe('local tsc --noEmit\n');
		expect((await b.commands.run(`cd ${APP} && bunx tsc -p .`)).stdout).toBe('local tsc -p .\n');
		expect((await b.commands.run(`cd ${APP} && bun x --bun tsc -v`)).stdout).toBe('local tsc -v\n');
	});

	it('bun create <template> runs create-<template> with bun as the user agent', async () => {
		const b = await box({
			'node_modules/create-thing/package.json': JSON.stringify({ name: 'create-thing', version: '1.0.0', bin: { 'create-thing': './index.js' } }),
			'node_modules/create-thing/index.js': `console.log('create-thing', process.argv.slice(2).join(' '), process.env.npm_config_user_agent.split('/')[0]);\n`,
		});
		const r = await b.commands.run(`cd ${APP} && bun create thing my-app --template react`);
		expect(r.stdout).toBe('create-thing my-app --template react bun\n');
		const gh = await b.commands.run(`cd ${APP} && bun create someone/repo`);
		expect(gh.exitCode).toBe(1);
		expect(gh.stderr).toContain("GitHub templates aren't available in a box yet");
	});

	it('bun init writes a blank TypeScript project that runs', async () => {
		const b = await box({});
		// No registry here: the files are written and init still succeeds, as Bun's does.
		const r = await b.commands.run(`mkdir -p ${APP} && cd ${APP} && NPM_REGISTRY=http://127.0.0.1:9 bun init && bun run index.ts`);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain(' + index.ts\n');
		expect(r.stdout).toContain('Hello via Bun!\n');
		const pkg = JSON.parse(await b.fs.readFile(`${APP}/package.json`, 'utf8') as string);
		expect(pkg).toMatchObject({ name: 'app', module: 'index.ts', type: 'module', devDependencies: { '@types/bun': 'latest' } });
		expect(await b.fs.exists(`${APP}/tsconfig.json`)).toBe(true);
	});

	it('evaluates code, and says what a box does not have', async () => {
		const b = await box({});
		expect((await b.commands.run('bun -p "1 + 2"')).stdout).toBe('3\n');
		expect((await b.commands.run(`bun -e "console.log('evaluated')"`)).stdout).toBe('evaluated\n');
		const t = await b.commands.run('bun test');
		expect(t.exitCode).toBe(1);
		expect(t.stderr).toContain("bun test isn't available in a Lifo box yet");
		expect((await b.commands.run('bun add')).stderr).toContain('no package specified');
	});

	it('warns when a file uses Bun APIs a box does not have', async () => {
		const b = await box({ 'server.ts': `const server = Bun.serve({ port: 3000, fetch: () => new Response('hi') });\n` });
		const r = await b.commands.run(`cd ${APP} && bun server.ts`);
		expect(r.stderr).toContain("server.ts uses Bun's own APIs");
		expect(r.exitCode).not.toBe(0);
	});
});

describe('parseDotEnv', () => {
	it('handles export, quotes, comments, escapes and expansion', () => {
		const env = parseDotEnv([
			'# comment',
			'export A=1',
			'B = two words  # trailing',
			`C='single $A'`,
			'D="line\\nnext ${A}"',
			'E=${B}-$HOME',
			'F=',
		].join('\n'), (k) => (k === 'HOME' ? '/home/user' : undefined));
		expect(env).toEqual({ A: '1', B: 'two words', C: 'single $A', D: 'line\nnext 1', E: 'two words-/home/user', F: '' });
	});
});
