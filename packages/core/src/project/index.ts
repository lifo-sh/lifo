/**
 * project: one plan for a project wherever Lifo runs (see plan.ts).
 *
 *   const plan = planProject(box.kernel.vfs, '/home/user/app', { mode: 'prod' });
 *   plan.install, plan.build, plan.start, plan.port, plan.needs
 */

import type { VFS } from '../kernel/vfs/index.js';
import { dockerfileReader } from './dockerfile.js';
import { nodeReader } from './node.js';
import { registerProjectReader, resolvePlan, type ProjectFiles, type ProjectMode, type ProjectPlan } from './plan.js';

registerProjectReader(nodeReader);

export * from './plan.js';
export { nodeReader, portInCommand } from './node.js';
export { dockerfileReader, dockerfileLayer, parseDockerfile, toNpm } from './dockerfile.js';

/** A VFS as the files a plan reads. */
export function vfsProjectFiles(vfs: VFS): ProjectFiles {
	return {
		read: (p) => (vfs.exists(p) ? vfs.readFileString(p) : null),
		exists: (p) => vfs.exists(p),
	};
}

/** The plan for the project in `dir`, read from these files (package.json, Dockerfile, lifo.json). */
export function planProject(files: VFS | ProjectFiles, dir: string, opts: { mode?: ProjectMode; ignoreDockerfile?: boolean } = {}): ProjectPlan {
	const pf: ProjectFiles = 'readFileString' in files ? vfsProjectFiles(files as VFS) : (files as ProjectFiles);
	return resolvePlan(pf, { dir, mode: opts.mode, ignoreDockerfile: opts.ignoreDockerfile, dockerfile: dockerfileReader });
}
