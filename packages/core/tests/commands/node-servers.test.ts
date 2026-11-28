// The node runner keeps a run alive while any server listens, including servers that start
// after it began waiting (Vite opens a short-lived server before its dev server).
import { describe, it, expect } from 'vitest';
import { VFS } from '../../src/kernel/vfs/index.js';

describe('node command and servers', () => {
	it('waits for a server that starts while it is waiting on another', async () => {
		const { default: node } = await import('../../src/commands/system/node.js');
		const vfs = new VFS();
		vfs.mkdir('/tmp');
		vfs.writeFile('/tmp/servers.js', [
			`const http = require('http');`,
			`const first = http.createServer().listen(4101);`,
			`setTimeout(() => {`,
			`  const second = http.createServer().listen(4102);`,
			`  first.close();`,
			`  setTimeout(() => { console.log('second closing'); second.close(); }, 300);`,
			`}, 100);`,
		].join('\n'));
		const out = { text: '', write(t: string) { this.text += t; } };
		const err = { text: '', write(t: string) { this.text += t; } };
		const started = Date.now();
		const code = await node({ args: ['/tmp/servers.js'], env: {}, cwd: '/tmp', vfs, stdout: out, stderr: err, signal: new AbortController().signal });
		expect(code).toBe(0);
		expect(out.text).toBe('second closing\n');
		expect(Date.now() - started).toBeGreaterThanOrEqual(350);
	});

	it('takes response headers in every form Node does (srvx sends a flat list)', async () => {
		const { Sandbox } = await import('../../src/sandbox/Sandbox.js');
		const box = await Sandbox.create({ persist: false });
		await box.fs.writeFile('/tmp/headers.js', [
			`require('http').createServer((req, res) => {`,
			`  if (req.url === '/flat') res.writeHead(200, 'OK', ['content-type', 'text/html', 'set-cookie', 'a=1', 'set-cookie', 'b=2']);`,
			`  else if (req.url === '/pairs') res.writeHead(201, [['content-type', 'text/plain'], ['x-one', '1']]);`,
			`  else { res.setHeaders(new Headers({ 'content-type': 'application/json', 'x-two': '2' })); res.writeHead(202); }`,
			`  res.end('ok');`,
			`}).listen(4110);`,
		].join('\n'));
		void box.commands.run('node /tmp/headers.js');
		await new Promise((r) => setTimeout(r, 300));
		const flat = await box.fetch('http://localhost:4110/flat');
		const pairs = await box.fetch('http://localhost:4110/pairs');
		const map = await box.fetch('http://localhost:4110/headers');
		expect([flat.status, flat.headers.get('content-type'), flat.headers.get('set-cookie')]).toEqual([200, 'text/html', 'a=1, b=2']);
		expect([pairs.status, pairs.headers.get('content-type'), pairs.headers.get('x-one')]).toEqual([201, 'text/plain', '1']);
		expect([map.status, map.headers.get('content-type'), map.headers.get('x-two')]).toEqual([202, 'application/json', '2']);
		await box.destroy?.();
	});
});
