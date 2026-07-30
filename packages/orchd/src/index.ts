/**
 * The programmatic API: `import { resolveAll } from 'orchd'`.
 *
 * Only the pure manifest layer is re-exported here — a host driver wanting
 * `{ cwd, argv, env, install }` should not have to load a runner, and neither
 * runner should be reachable from a plain import (the bin is ./cli.js, the box
 * command is ./lifo.js).
 */
export * from './manifest.js';
