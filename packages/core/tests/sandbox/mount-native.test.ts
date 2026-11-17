import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

describe('Sandbox mounts', () => {
	it('mounts a host folder under a path whose parents do not exist yet, and still snapshots', async () => {
		const host = fs.mkdtempSync(path.join(os.tmpdir(), 'lifo-mount-'));
		fs.writeFileSync(path.join(host, 'notes.txt'), 'from the host');
		try {
			// No fsModule: core has to find node:fs itself (ES modules have no `require`).
			const sb = await Sandbox.create({ mounts: [{ virtualPath: '/mnt/deep/project', hostPath: host, readOnly: true }] });
			expect(await sb.fs.readFile('/mnt/deep/project/notes.txt')).toBe('from the host');
			expect((await sb.fs.readdir('/mnt/deep')).map((e) => e.name)).toEqual(['project']);
			const snap = await sb.exportSnapshot();
			expect(snap.byteLength).toBeGreaterThan(0);
		} finally {
			fs.rmSync(host, { recursive: true, force: true });
		}
	});
});
