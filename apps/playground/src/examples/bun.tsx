import { ProjectExample } from '@/examples/project-example';

const DIR = '/home/user/bun-demo';

const files: Record<string, string> = {
  [`${DIR}/package.json`]: JSON.stringify({ name: 'bun-demo', type: 'module', scripts: { greet: 'bun greet.ts' } }, null, 2) + '\n',
  [`${DIR}/.env`]: 'GREET_NAME=Bun in a box\n',
  [`${DIR}/greet.ts`]: `// TypeScript runs directly: bun greet.ts (bun loads .env too)
interface Greeting {
  name: string;
  times: number;
}

enum Mood {
  Happy = '🙂',
  Excited = '🎉',
}

const greeting: Greeting = { name: process.env.GREET_NAME ?? 'world', times: 2 };
for (let i = 0; i < greeting.times; i++) {
  console.log(\`Hello, \${greeting.name} \${i === 0 ? Mood.Happy : Mood.Excited}\`);
}
console.log(\`(user agent: \${process.env.npm_config_user_agent?.split(' ')[0]})\`);
`,
};

export default function BunExample() {
  return (
    <ProjectExample
      title="Bun"
      subtitle={
        <>
          Bun&apos;s CLI on Lifo&apos;s npm and node: <code>bun greet.ts</code> runs TypeScript
          directly, <code>bun run greet</code> runs a script, and{' '}
          <code>bun create vite my-app</code>, <code>bun install</code>, <code>bun dev</code> work
          as on your machine. Bun&apos;s own APIs (<code>Bun.serve</code>, <code>bun:sqlite</code>)
          aren&apos;t in a box yet.
        </>
      }
      files={files}
      cwd={DIR}
      previewPort={5173}
      worker
    />
  );
}
