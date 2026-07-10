/** Static anon JWT for the in-VM tinbase (Supabase-style) backend. */
const TINBASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpbmJhc2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc4MzI3MzU0OSwiZXhwIjoyMDk4NjMzNTQ5fQ.yaaSYTyy2tRkx1myq06zU1ieZiWeJyq_hAZk2qCZEmk';

export function tinbaseTodoAppFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: 'tinbase-todo', version: '1.0.0', type: 'module',
		scripts: {
			backend: 'node server.mjs',
			dev: 'vite',
			build: 'vite build',
		},
		dependencies: {
			vite: '^7.3.1',
			typescript: '~5.9.3',
			react: '^18.3.1',
			'react-dom': '^18.3.1',
			'@vitejs/plugin-react': '^5.0.0',
			'@types/react': '^18.3.12',
			'@types/react-dom': '^18.3.1',
			tinbase: '^0.8.1',
			// JS-based Postgres engine (@tinbase/pg-mem fork: PL/pgSQL, triggers,
			// RLS). tinbase's createPgmemEngine imports it as `pg-mem`.
			'pg-mem': 'npm:@tinbase/pg-mem@^3.2.0',
			'@supabase/supabase-js': '^2.110.0',
		},
	}, null, 2);

	// The backend: tinbase's fetch handler wrapped in a node http server, run
	// inside the VM on port 54321. The database is @tinbase/pg-mem — a pure-JS
	// Postgres engine (PL/pgSQL, triggers, RLS) — so boot is instant and no
	// wasm loads; only JSON crosses the service worker.
	files[`${root}/server.mjs`] = `import { createBackend, createPgmemEngine } from 'tinbase'
import http from 'node:http'

const backend = await createBackend({
  // pg-mem engine: pure-JS Postgres (no wasm) — instant boot. Drop this line
  // to use the default PGlite (Postgres/wasm) engine instead.
  engine: await createPgmemEngine(),
  migrations: [{
    name: '20240101000000_todos',
    sql: \`create table if not exists todos (
      id bigint generated always as identity primary key,
      title text not null,
      done boolean not null default false,
      created_at timestamptz not null default now()
    );\`,
  }],
})

// tinbase is a (Request) => Response handler; expose it over HTTP.
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    try {
      const url = 'http://localhost:54321' + req.url
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0
      const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? body : undefined })
      const response = await backend.fetch(request)
      const buf = new Uint8Array(await response.arrayBuffer())
      const headers = {}
      response.headers.forEach((v, k) => { headers[k] = v })
      res.writeHead(response.status, headers)
      res.end(buf)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('server error: ' + (e && e.message))
    }
  })
})

server.listen(54321, () => {
  // Print the connection details like \`supabase start\` does — Studio's login
  // asks for the service_role key.
  console.log('tinbase running on port 54321 (like supabase start)')
  console.log('')
  console.log('         API URL: http://localhost:54321')
  console.log('      Studio URL: http://localhost:54321/_/  (the Studio preview tab)')
  console.log('        anon key: ' + backend.anonKey)
  console.log('service_role key: ' + backend.serviceRoleKey)
  console.log('')
  console.log('data persists while this server is running')
})
`;

	files[`${root}/vite.config.ts`] = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`;

	files[`${root}/tsconfig.json`] = JSON.stringify({
		compilerOptions: {
			target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
			jsx: 'react-jsx',
			strict: true, noEmit: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'],
			types: ['vite/client'],
		},
		include: ['src'],
	}, null, 2);

	// Standard Supabase config lives in .env — the only Lifo-specific bit is the
	// URL path (/_sw/54321), which the service worker routes to the in-VM server.
	files[`${root}/.env`] = `VITE_SUPABASE_URL=/_sw/54321\nVITE_SUPABASE_ANON_KEY=${TINBASE_ANON_KEY}\n`;

	files[`${root}/index.html`] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Todos · tinbase in Lifo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a2e; }
    h1 { font-size: 1.4rem; } .sub { color: #6b7280; font-size: .85rem; margin-top: -.6rem; }
    form { display: flex; gap: .5rem; margin: 1.25rem 0; }
    input[type=text] { flex: 1; padding: .55rem .7rem; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; }
    button { padding: .55rem .9rem; border: none; border-radius: 8px; background: #3ecf8e; color: #05291b; font-weight: 600; cursor: pointer; }
    ul { list-style: none; padding: 0; } li { display: flex; align-items: center; gap: .6rem; padding: .5rem .2rem; border-bottom: 1px solid #eee; }
    li.done span { text-decoration: line-through; color: #9ca3af; } li span { flex: 1; }
    .del { background: transparent; color: #ef4444; font-weight: 700; padding: .2rem .5rem; }
    #status { font-size: .8rem; color: #6b7280; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`;

	files[`${root}/src/supabase.ts`] = `import { createClient } from '@supabase/supabase-js'

// Standard supabase-js against the tinbase server running in the Lifo VM.
// The URL + anon key come from .env, exactly like a real Supabase project;
// the URL is resolved to an absolute one so the service worker can route it.
const url = new URL(import.meta.env.VITE_SUPABASE_URL, location.origin).href
export const supabase = createClient(url, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
`;

	files[`${root}/src/main.tsx`] = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
`;

	files[`${root}/src/App.tsx`] = `import { useEffect, useState } from 'react'
import { supabase } from './supabase'

interface Todo { id: number; title: string; done: boolean }

export function App() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('connecting…')

  async function refresh() {
    const { data, error } = await supabase.from('todos').select('*').order('id')
    if (error) {
      setStatus('Cannot reach backend: ' + error.message + ' — did you run "npm run backend &"?')
      return
    }
    setTodos((data ?? []) as Todo[])
    setStatus((data?.length ?? 0) + ' todo(s) · tinbase (Postgres) in the Lifo VM — persists across app reloads')
  }

  useEffect(() => { refresh() }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    setTitle('')
    await supabase.from('todos').insert({ title: t })
    refresh()
  }

  async function toggle(todo: Todo) {
    await supabase.from('todos').update({ done: !todo.done }).eq('id', todo.id)
    refresh()
  }

  async function remove(todo: Todo) {
    await supabase.from('todos').delete().eq('id', todo.id)
    refresh()
  }

  return (
    <>
      <h1>📝 Todos</h1>
      <p className="sub">Vite + React + TypeScript · supabase-js → tinbase server running in Lifo</p>
      <form onSubmit={add}>
        <input type="text" placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button>Add</button>
      </form>
      <ul>
        {todos.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
            <span>{t.title}</span>
            <button className="del" onClick={() => remove(t)}>✕</button>
          </li>
        ))}
      </ul>
      <p id="status">{status}</p>
    </>
  )
}
`;

	return files;
}

