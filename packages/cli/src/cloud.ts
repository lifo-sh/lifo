/**
 * `lifo-sh cloud ...` on the host: Lifo Cloud from a normal terminal.
 *
 * `push` puts the current directory in a box (at /home/user/app) and runs `lifo cloud push` there,
 * so the host and the in-box command upload the same thing. `pull` saves the cloud box as a
 * .tar.gz here (the same snapshot format `lifo-sh snapshot` and the browser use). `shell` connects
 * this terminal to a shell in the cloud box, like ssh. Everything else is the in-box command, run
 * with the host's login.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Sandbox, LifoCloud, createShellEscape, type WebSocketConstructor } from '@lifo-sh/core';
import { boxAuthEnv, resolveHostAuth, takeBaseUrlFlag } from './auth.js';

const APP_DIR = '/home/user/app';

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

export async function handleCloud(args: string[]): Promise<number> {
	const { flag, rest } = takeBaseUrlFlag(args);
	const sub = rest[0];

	if ((sub === 'shell' || sub === 'ssh') && rest[1]) {
		const auth = await resolveHostAuth(flag);
		if (!auth.token) {
			console.error(`lifo cloud: not logged in to ${auth.baseUrl}. Run 'lifo-sh login' first.`);
			return 1;
		}
		const cloud = await LifoCloud.connect({ token: auth.token, baseUrl: auth.baseUrl, url: process.env.LIFO_CLOUD_URL });
		return hostShell(cloud, rest[1]);
	}

	if (sub === 'pull' && rest[1]) {
		const name = rest[1];
		const auth = await resolveHostAuth(flag);
		if (!auth.token) {
			console.error(`lifo cloud: not logged in to ${auth.baseUrl}. Run 'lifo-sh login' first.`);
			return 1;
		}
		const cloud = await LifoCloud.connect({ token: auth.token, baseUrl: auth.baseUrl, url: process.env.LIFO_CLOUD_URL });
		const withData = rest.includes('--with-data');
		const positional = rest.slice(2).filter((a) => !a.startsWith('--'));
		const bytes = await cloud.pull(name);
		const file = path.resolve(positional[0] ?? `${name}.tar.gz`);
		fs.writeFileSync(file, bytes);
		console.log(`Saved ${name} to ${file}. Open it with: lifo-sh snapshot restore ${path.basename(file)}`);
		if (withData) {
			const sql = await cloud.dataSql(name);
			if (sql === null) console.log(`${name} has no database yet.`);
			else {
				const sqlFile = file.replace(/\.tar\.gz$|$/, '.data.sql');
				fs.writeFileSync(sqlFile, sql);
				console.log(`Its database's data is in ${sqlFile} (SQL INSERTs for the public schema; load it with psql, or append it to supabase/seed.sql for tinbase).`);
			}
		}
		return 0;
	}

	const env = await boxAuthEnv();
	if (flag) env.LIFO_BASE_URL = flag;
	if (process.env.LIFO_CLOUD_URL) env.LIFO_CLOUD_URL = process.env.LIFO_CLOUD_URL;
	const push = sub === 'push';
	const box = await Sandbox.create({
		env,
		cwd: push ? APP_DIR : undefined,
		mounts: push ? [{ virtualPath: APP_DIR, hostPath: process.cwd(), readOnly: true }] : undefined,
	});
	try {
		const extra = push && !rest.some((a) => a.startsWith('--exclude')) ? ['--exclude', '.git'] : [];
		const line = ['lifo', 'cloud', ...rest, ...extra].map(quote).join(' ');
		if (push) console.log(`Pushing ${process.cwd()} as ${APP_DIR}${extra.length ? ' (without .git)' : ''}`);
		const r = await box.commands.run(line, {
			cwd: push ? APP_DIR : undefined,
			onStdout: (d) => process.stdout.write(d),
			onStderr: (d) => process.stderr.write(d),
		});
		return r.exitCode;
	} finally {
		box.destroy();
	}
}

/** This terminal becomes the cloud box's: raw keys in, its output out, until `exit` or `~.`. */
async function hostShell(cloud: LifoCloud, name: string): Promise<number> {
	const WebSocket =
		(globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ??
		((await import('ws')).WebSocket as unknown as WebSocketConstructor);
	const out = process.stdout;
	let sh;
	try {
		sh = await cloud.shell(name, { cols: out.columns || 80, rows: out.rows || 24, WebSocket });
	} catch (e) {
		console.error(`lifo cloud shell: ${(e as Error).message}`);
		return 1;
	}
	const stdin = process.stdin;
	const tty = stdin.isTTY;
	if (tty) stdin.setRawMode(true);
	stdin.setEncoding('utf8');
	stdin.resume();
	const escape = createShellEscape();
	const onResize = () => sh.resize(out.columns || 80, out.rows || 24);
	out.on('resize', onResize);
	let disconnected = false;
	const onKeys = (data: string) => {
		const { send, disconnect } = escape(data);
		if (send) sh.write(send);
		if (disconnect) {
			disconnected = true;
			sh.close();
		}
	};
	stdin.on('data', onKeys);
	sh.onData((d) => out.write(d));
	const end = await new Promise<{ code: number; reason: string }>((resolve) => sh.onClose((code, reason) => resolve({ code, reason })));
	stdin.off('data', onKeys);
	out.off('resize', onResize);
	if (tty) stdin.setRawMode(false);
	stdin.pause();
	if (disconnected) {
		out.write(`\r\nDisconnected from ${name}. It keeps running.\r\n`);
		return 0;
	}
	if (end.code === 1000) return 0;
	console.error(`\r\nlifo cloud shell: ${end.reason || `connection closed (${end.code})`}`);
	return 1;
}
