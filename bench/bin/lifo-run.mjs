// Minimal "lifo as a single command": boot a box, run the argv command, exit.
// Compiled to a standalone executable with `bun build --compile` for the
// single-binary cold-start benchmark.
import { Sandbox } from '../../packages/core/dist/index.js';

const cmd = process.argv.slice(2).join(' ') || 'true';
const sb = await Sandbox.create({ persist: false });
const r = await sb.commands.run(cmd);
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.exitCode ?? 0);
