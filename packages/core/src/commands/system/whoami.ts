import type { Command } from '../types.js';

// The Unix user, as everywhere else. The lifo.sh account is `lifo whoami` (lifo-cloud.ts).
const command: Command = async (ctx) => {
  ctx.stdout.write((ctx.env.USER || 'user') + '\n');
  return 0;
};

export default command;
