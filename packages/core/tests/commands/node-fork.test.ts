// child_process.fork(): another node run in the box with an IPC channel to its parent, as
// `next dev` starts its server (child sends ready, parent sends options, child reports back).
import { describe, it, expect } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

async function run(files: Record<string, string>, cmd: string) {
	const box = await Sandbox.create({ persist: false });
	await box.fs.mkdir('/tmp/f', { recursive: true });
	for (const [name, src] of Object.entries(files)) await box.fs.writeFile(`/tmp/f/${name}`, src);
	return box.commands.run(`cd /tmp/f && ${cmd}`);
}

describe('child_process.fork', () => {
	it('talks to the child over IPC, keeps both alive while it does, and reports the exit', async () => {
		const r = await run({
			'parent.js': [
				`const { fork } = require('child_process');`,
				`const child = fork('./child.js', ['a1'], { env: { ...process.env, ROLE: 'worker' } });`,
				`child.on('message', (m) => {`,
				`  if (m.ready) setTimeout(() => child.send({ options: { port: 3000 } }), 200);`,
				`  else console.log('parent got', JSON.stringify(m));`,
				`});`,
				`child.on('exit', (code, signal) => console.log('child exit', code, signal, child.connected));`,
			].join('\n'),
			'child.js': [
				`console.log('child', process.argv[2], process.env.ROLE, process.connected);`,
				`process.on('message', (m) => {`,
				`  process.send({ got: m.options.port, fn: undefined });`,
				`  process.disconnect();`,
				`});`,
				`process.send({ ready: true });`,
			].join('\n'),
		}, 'node parent.js');
		expect(r.stdout).toBe('child a1 worker true\nparent got {"got":3000}\nchild exit 0 null false\n');
		expect(r.exitCode).toBe(0);
	});

	it('kill() stops the child and reports the signal', async () => {
		const r = await run({
			'parent.js': [
				`const child = require('child_process').fork('./child.js', { stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });`,
				`child.stdout.setEncoding('utf8');`,
				`child.stdout.on('data', (d) => { console.log('piped:', d.trim()); child.kill(); });`,
				`child.on('exit', (code, signal) => console.log('exit', code, signal, child.killed));`,
			].join('\n'),
			'child.js': `require('http').createServer(() => {}).listen(4310, () => console.log('listening'));`,
		}, 'node parent.js');
		expect(r.stdout).toBe('piped: listening\nexit null SIGTERM true\n');
	});
});
