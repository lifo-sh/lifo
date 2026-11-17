import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

// Sandbox runs the box in the realm that creates it. In a browser page it says so once, unless the
// caller passed realm: 'page'; nothing about the box changes either way.
describe("Sandbox realm note", () => {
	const g = globalThis as Record<string, unknown>;
	afterEach(() => {
		delete g.window;
		delete g.document;
		vi.restoreAllMocks();
	});

	it('is silent outside a browser page (Node, workers, workerd)', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		(await Sandbox.create()).destroy();
		expect(info).not.toHaveBeenCalled();
	});

	it("is silent in a page with realm: 'page', and prints once otherwise", async () => {
		g.window = g;
		g.document = {};
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const quiet = await Sandbox.create({ realm: 'page' });
		expect(info).not.toHaveBeenCalled();
		expect((await quiet.commands.run('echo ok')).stdout).toBe('ok\n');
		quiet.destroy();
		(await Sandbox.create()).destroy();
		(await Sandbox.create()).destroy();
		expect(info).toHaveBeenCalledTimes(1);
		expect(String(info.mock.calls[0][0])).toContain('WorkerSandbox');
	});
});
