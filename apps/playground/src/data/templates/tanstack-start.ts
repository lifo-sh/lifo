/**
 * A TanStack Start app, the shape `npx @tanstack/cli create` scaffolds without its add-ons:
 * Vite 8 with the Start plugin, file-based routes (src/routes), a server function the home
 * page's loader calls during server rendering, and a client-side counter, so the preview shows
 * server rendering, hydration, client navigation and HMR.
 */
export function tanstackStartFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: root.split('/').pop(),
		private: true,
		type: 'module',
		scripts: { dev: 'vite dev --port 3000', build: 'vite build' },
		dependencies: {
			'@tanstack/react-router': '^1.170.46',
			'@tanstack/react-start': '^1.169.7',
			react: '^19.2.3',
			'react-dom': '^19.2.3',
		},
		devDependencies: {
			'@types/react': '^19.2.0',
			'@types/react-dom': '^19.2.0',
			'@vitejs/plugin-react': '^6.0.1',
			typescript: '^5.9.3',
			vite: '^8.0.0',
		},
	}, null, 2) + '\n';

	files[`${root}/vite.config.ts`] = `import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [tanstackStart(), viteReact()],
})
`;

	files[`${root}/tsconfig.json`] = JSON.stringify({
		include: ['**/*.ts', '**/*.tsx'],
		compilerOptions: {
			target: 'ES2022',
			jsx: 'react-jsx',
			module: 'ESNext',
			lib: ['ES2022', 'DOM', 'DOM.Iterable'],
			types: ['vite/client'],
			moduleResolution: 'bundler',
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			noEmit: true,
			skipLibCheck: true,
			strict: true,
		},
	}, null, 2) + '\n';

	files[`${root}/src/router.tsx`] = `import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
`;

	files[`${root}/src/routes/__root.tsx`] = `import type { ReactNode } from 'react'
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'TanStack Start in Lifo' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <nav>
        <Link to="/" activeProps={{ className: 'active' }} activeOptions={{ exact: true }}>Home</Link>
        <Link to="/about" activeProps={{ className: 'active' }}>About</Link>
      </nav>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
`;

	files[`${root}/src/routes/index.tsx`] = `import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

// Runs on the server (in the box), also when the page navigates on the client.
const getServerInfo = createServerFn({ method: 'GET' }).handler(async () => ({
  renderedAt: new Date().toLocaleTimeString(),
  node: process.version,
}))

export const Route = createFileRoute('/')({
  loader: () => getServerInfo(),
  component: Home,
})

function Home() {
  const info = Route.useLoaderData()
  const [count, setCount] = useState(0)
  return (
    <main>
      <h1>TanStack Start inside Lifo</h1>
      <p>
        Rendered on the server at {info.renderedAt} by Node {info.node}, in your browser.
      </p>
      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
      <p className="hint">
        Edit <code>src/routes/index.tsx</code> and save to see HMR.
      </p>
    </main>
  )
}
`;

	files[`${root}/src/routes/about.tsx`] = `import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

function About() {
  return (
    <main>
      <h1>About</h1>
      <p>A file-based route: src/routes/about.tsx. The link above navigated on the client.</p>
    </main>
  )
}
`;

	files[`${root}/src/styles.css`] = `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  color-scheme: light dark;
}
nav {
  display: flex;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid #8884;
}
nav a { color: inherit; text-decoration: none; opacity: 0.7; }
nav a.active { opacity: 1; font-weight: 600; }
main { padding: 24px; }
button { font-size: 1em; padding: 0.6em 1.2em; cursor: pointer; }
.hint { color: #888; }
`;

	return files;
}
