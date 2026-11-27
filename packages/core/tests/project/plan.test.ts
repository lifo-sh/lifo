import { describe, expect, it } from 'vitest';
import { planProject, startWithInstall, toNpm, type ProjectFiles } from '../../src/project/index.js';
import { Sandbox } from '../../src/sandbox/Sandbox.js';

/** A project as a map of files under /app. */
function files(map: Record<string, string | object>): ProjectFiles {
	const all = new Map(Object.entries(map).map(([k, v]) => [`/app/${k}`, typeof v === 'string' ? v : JSON.stringify(v)]));
	return {
		read: (p) => all.get(p) ?? null,
		exists: (p) => all.has(p) || [...all.keys()].some((k) => k.startsWith(p + '/')),
	};
}

const dev = (f: ProjectFiles) => planProject(f, '/app', { mode: 'dev' });
const prod = (f: ProjectFiles) => planProject(f, '/app', { mode: 'prod' });

describe('package.json', () => {
	it('uses the scripts: dev in dev, build then start in prod', () => {
		const f = files({ 'package.json': { scripts: { dev: 'node dev.js --port 4000', build: 'tsc', start: 'node dist/server.js' }, dependencies: { express: '^4' } } });
		const d = dev(f);
		expect(d).toMatchObject({ install: 'npm install', installedWhen: 'node_modules', build: [], start: 'npm run dev', port: 4000 });
		expect(d.needs).toEqual([{ name: 'node', from: 'package.json' }]);
		const p = prod(f);
		expect(p).toMatchObject({ install: 'npm install', build: ['npm run build'], start: 'npm start', port: null });
	});

	it('fills in Next.js defaults where scripts are missing', () => {
		const f = files({ 'package.json': { dependencies: { next: '15', react: '19' } } });
		expect(dev(f)).toMatchObject({ framework: 'next', start: 'next dev', port: 3000 });
		expect(prod(f)).toMatchObject({ framework: 'next', build: ['next build'], start: 'next start -p 3000', port: 3000 });
	});

	it("doesn't run a dev server as the production start", () => {
		const f = files({ 'package.json': { scripts: { dev: 'vite', start: 'vite', build: 'vite build' }, devDependencies: { vite: '7' } } });
		const p = prod(f);
		expect(p.start).toBe('vite preview --port 4173');
		expect(p.port).toBe(4173);
		expect(dev(f)).toMatchObject({ start: 'npm run dev', port: 5173 });
	});

	it('gives Vite-based server frameworks no vite preview', () => {
		const f = files({ 'package.json': { scripts: { dev: 'vite dev', build: 'vite build' }, devDependencies: { vite: '7', '@sveltejs/kit': '2' } } });
		const p = prod(f);
		expect(p.framework).toBe('@sveltejs/kit');
		expect(p.start).toBeNull();
		expect(p.notes.join('\n')).toMatch(/no start command found/);
	});

	it('falls back to node <entry>', () => {
		const f = files({ 'package.json': { name: 'x' }, 'server.js': 'x' });
		expect(dev(f)).toMatchObject({ install: null, start: 'node server.js' });
		expect(prod(f)).toMatchObject({ build: [], start: 'node server.js' });
	});

	it('records engines.node as the version it needs', () => {
		expect(dev(files({ 'package.json': { engines: { node: '>=20' } } })).needs).toEqual([{ name: 'node', version: '>=20', from: 'package.json' }]);
	});
});

describe('lifo.json', () => {
	it('sets any part, per mode', () => {
		const f = files({
			'package.json': { scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '7' } },
			'lifo.json': { dev: 'vite --host', start: 'node server.js', build: ['npm run build', 'node scripts/post.js'], port: 8080, env: { A: 1 } },
		});
		expect(dev(f)).toMatchObject({ start: 'vite --host', port: 8080, env: { A: '1' } });
		expect(prod(f)).toMatchObject({ start: 'node server.js', build: ['npm run build', 'node scripts/post.js'], port: 8080 });
		expect(prod(f).sources).toEqual(['package.json', 'lifo.json']);
	});
});

describe('Dockerfile', () => {
	it('reads a single-stage Node Dockerfile as the production recipe', () => {
		const f = files({
			'package.json': { scripts: { dev: 'node --watch server.js', start: 'node server.js' }, dependencies: { express: '4' } },
			Dockerfile: `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
`,
		});
		const p = prod(f);
		expect(p).toMatchObject({ install: null, build: ['npm ci --omit=dev'], start: 'node server.js', port: 8080, env: { NODE_ENV: 'production' } });
		// The Dockerfile's FROM says which node.
		expect(p.needs).toEqual([{ name: 'node', version: '20-alpine', from: 'FROM node:20-alpine in Dockerfile' }]);
		// In dev the package.json dev script wins, and production's env and port stay out.
		const d = dev(f);
		expect(d).toMatchObject({ start: 'npm run dev', install: 'npm install', build: [], env: {} });
		expect(d.port).toBeNull();
	});

	it('maps a Next.js standalone multi-stage build', () => {
		const f = files({
			'package.json': { dependencies: { next: '15' }, scripts: { build: 'next build', start: 'next start' } },
			Dockerfile: `ARG NODE=20
FROM node:\${NODE}-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json yarn.lock* package-lock.json* ./
RUN \\
  if [ -f yarn.lock ]; then yarn --frozen-lockfile; \\
  else npm ci; fi

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
`,
		});
		const p = prod(f);
		expect(p.build).toEqual([
			'if [ -f yarn.lock ]; then yarn --frozen-lockfile; else npm ci; fi',
			'npm run build',
			'mkdir -p .next/standalone && cp -r public .next/standalone/public',
			'mkdir -p .next/standalone/.next && cp -r .next/static .next/standalone/.next/static',
		]);
		expect(p.install).toBeNull();
		expect(p.buildEnv).toEqual({ NEXT_TELEMETRY_DISABLED: '1' });
		expect(p.start).toBe('cd .next/standalone && node server.js');
		expect(p.port).toBe(3000);
		expect(p.env).toEqual({ NODE_ENV: 'production', PORT: '3000' });
		expect(p.needs.map((n) => n.name)).toEqual(['node']);
		const left = p.skipped.map((s) => s.what).join('\n');
		expect(left).toMatch(/apk add/);
		expect(left).toMatch(/addgroup/);
		expect(left).toMatch(/USER nextjs/);
	});

	it('says what a Go project needs, and is the whole recipe when nothing else knows the project', () => {
		const f = files({
			'go.mod': 'module x',
			Dockerfile: `FROM golang:1.23 AS build
WORKDIR /src
COPY . .
RUN go build -o app .
FROM gcr.io/distroless/static-debian12
COPY --from=build /src/app /app
EXPOSE 8080
ENTRYPOINT ["/app"]
`,
		});
		for (const p of [dev(f), prod(f)]) {
			expect(p.needs).toEqual([{ name: 'go', version: '1.23', from: 'FROM golang:1.23 in Dockerfile' }]);
			expect(p.build[0]).toBe('go build -o app .');
			expect(p.port).toBe(8080);
		}
	});

	it('drops system package installs from a RUN, keeping the rest', () => {
		const p = prod(files({ Dockerfile: 'FROM python:3.12-slim\nWORKDIR /srv\nRUN apt-get update && apt-get install -y gcc && pip install -r requirements.txt\nCMD python app.py\n' }));
		expect(p.build).toEqual(['pip install -r requirements.txt']);
		expect(p.start).toBe('python app.py');
		expect(p.needs[0]).toMatchObject({ name: 'python', version: '3.12-slim' });
		expect(p.skipped[0].why).toMatch(/system packages/);
	});

	it('runs yarn and pnpm lines with npm, and RUNs in a deeper WORKDIR from there', () => {
		const p = prod(files({ Dockerfile: 'FROM node:22\nWORKDIR /app\nRUN corepack enable && pnpm install --frozen-lockfile\nWORKDIR /app/web\nRUN pnpm build\nCMD ["pnpm", "start"]\n' }));
		expect(p.build).toEqual(['npm install', 'cd web && npm run build']);
		expect(p.start).toBe('cd web && pnpm start');
		expect(toNpm('yarn')).toBe('npm install');
		expect(toNpm('yarn build --prod')).toBe('npm run build --prod');
		expect(toNpm('pnpm exec tsc')).toBe('npx tsc');
		expect(toNpm('corepack enable')).toBeNull();
	});
});

describe('startWithInstall', () => {
	it('installs on the first start only', () => {
		const p = dev(files({ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '7' } } }));
		expect(startWithInstall(p)).toBe('{ test -e node_modules || npm install; npm run dev; }');
	});
});

describe('lifo plan, build, start, dev', () => {
	it('prints the plan and runs build then start', async () => {
		const box = await Sandbox.create();
		await box.fs.mkdir('/home/user/app', { recursive: true });
		await box.fs.writeFile(
			'/home/user/app/package.json',
			JSON.stringify({ scripts: { build: 'node build.js', start: 'node dist/out.js', dev: 'node dev.js' } }),
		);
		await box.fs.writeFile('/home/user/app/build.js', "require('fs').mkdirSync('dist',{recursive:true}); require('fs').writeFileSync('dist/out.js', 'console.log(\"built \" + process.env.PORT)')");
		await box.fs.writeFile('/home/user/app/dev.js', "console.log('dev!')");
		await box.fs.writeFile('/home/user/app/lifo.json', JSON.stringify({ port: 7000 }));

		const plan = await box.commands.run('lifo plan --prod', { cwd: '/home/user/app' });
		expect(plan.exitCode).toBe(0);
		expect(plan.stdout).toMatch(/build\s+npm run build/);
		expect(plan.stdout).toMatch(/start\s+npm start/);
		const json = JSON.parse((await box.commands.run('lifo plan app --json', { cwd: '/home/user' })).stdout);
		expect(json).toMatchObject({ mode: 'dev', start: 'npm run dev', dir: '/home/user/app' });

		const build = await box.commands.run('lifo build', { cwd: '/home/user/app' });
		expect(build.exitCode).toBe(0);
		expect(await box.fs.exists('/home/user/app/dist/out.js')).toBe(true);
		const start = await box.commands.run('lifo start', { cwd: '/home/user/app' });
		expect(start.exitCode).toBe(0);
		expect(start.stdout).toContain('built 7000');
		const devRun = await box.commands.run('lifo dev app', { cwd: '/home/user' });
		expect(devRun.stdout).toContain('dev!');
		box.destroy();
	});

	it("refuses a project whose toolchain isn't here, saying which", async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/Dockerfile', 'FROM golang:1.23\nRUN go build -o app .\nCMD ["./app"]\n');
		const r = await box.commands.run('lifo build');
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toMatch(/needs go 1\.23 \(FROM golang:1\.23 in Dockerfile\), which isn't in Lifo yet/);
		const dry = await box.commands.run('lifo start -n');
		expect(dry.exitCode).toBe(1);
		box.destroy();
	});

	it('dry-runs install and build', async () => {
		const box = await Sandbox.create();
		await box.fs.writeFile('/home/user/package.json', JSON.stringify({ dependencies: { next: '15' } }));
		const r = await box.commands.run('lifo build -n');
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain('$ npm install');
		expect(r.stdout).toContain('$ next build');
		box.destroy();
	});
});
