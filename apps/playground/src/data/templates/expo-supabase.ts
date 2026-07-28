/** Static anon JWT for the in-VM tinbase (Supabase-style) backend. */
const TINBASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpbmJhc2UiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc4MzI3MzU0OSwiZXhwIjoyMDk4NjMzNTQ5fQ.yaaSYTyy2tRkx1myq06zU1ieZiWeJyq_hAZk2qCZEmk';

export function expoSupabaseAppFiles(root: string): Record<string, string> {
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: 'expo-supabase-todo',
		version: '1.0.0',
		main: 'index.js',
		scripts: {
			start: 'node start.mjs',
		},
		dependencies: {
			expo: '~54.0.0',
			react: '19.1.0',
			'react-dom': '19.1.0',
			'react-native': '0.81.5',
			'react-native-web': '~0.21.0',
			'@expo/metro-runtime': '~6.1.2',
			'expo-router': '~6.0.24',
			'expo-linking': '~8.0.12',
			'expo-constants': '~18.0.13',
			'expo-status-bar': '~3.0.9',
			'react-native-safe-area-context': '~5.6.0',
			'react-native-screens': '~4.16.0',
			'@supabase/supabase-js': '^2.110.0',
		},
		devDependencies: {
			// The backend is the tinbase CLI (`npx tinbase`) — Supabase-compatible,
			// no server code. pg-mem is its pure-JS Postgres engine (--engine pgmem).
			tinbase: '^0.10.1',
			'pg-mem': 'npm:@tinbase/pg-mem@^3.2.0',
		},
	}, null, 2);

	files[`${root}/app.json`] = JSON.stringify({
		expo: {
			name: 'expo-supabase-todo',
			slug: 'expo-supabase-todo',
			scheme: 'lifoexposupabase',
			platforms: ['ios', 'android', 'web'],
			web: { bundler: 'metro', output: 'single' },
			plugins: ['expo-router'],
		},
	}, null, 2);

	// Fast Refresh requires the react-refresh runtime to load before any
	// component module — it must be the entry's first import.
	files[`${root}/index.js`] = `import '@expo/metro-runtime';
import 'expo-router/entry';
`;

	files[`${root}/babel.config.js`] = `module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
`;

	files[`${root}/metro.config.js`] = `const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);

if (require('os').platform() === 'lifo') {
  // In-band Metro (no worker forks), no Watchman binary.
  config.maxWorkers = 1;
  config.resolver.useWatchman = false;
}

module.exports = config;
`;

	// Standard Supabase config lives in .env, exactly like a real Expo project —
	// EXPO_PUBLIC_* vars are inlined by Metro. The only Lifo-specific bit is the
	// URL path (/_sw/54321), which the service worker routes to the in-VM server.
	files[`${root}/.env`] = `EXPO_PUBLIC_SUPABASE_URL=/_sw/54321\nEXPO_PUBLIC_SUPABASE_ANON_KEY=${TINBASE_ANON_KEY}\n`;

	files[`${root}/lib/supabase.js`] = `import { createClient } from '@supabase/supabase-js'

// Standard supabase-js against the tinbase server running in the Lifo VM.
// The URL + anon key come from .env, exactly like a real Supabase project;
// the URL is resolved to an absolute one so the service worker can route it.
// (During static rendering there is no \`location\` — any absolute base works,
// the client only fetches in effects, which don't run server-side.)
const base = typeof location !== 'undefined' ? location.origin : 'http://localhost:54321'
const url = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL, base).href
export const supabase = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
`;

	files[`${root}/app/_layout.js`] = `import { Stack } from 'expo-router';

export default function Layout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1a1b26' },
        headerTintColor: '#c0caf5',
        contentStyle: { backgroundColor: '#16161e' },
      }}
    />
  );
}
`;

	files[`${root}/app/index.js`] = `import { useEffect, useState } from 'react';
import {
  FlatList, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { supabase } from '../lib/supabase';

export default function Todos() {
  const [todos, setTodos] = useState([]);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('connecting…');

  async function refresh() {
    const { data, error } = await supabase.from('todos').select('*').order('id');
    if (error) {
      setStatus('Cannot reach backend: ' + error.message + ' — did you run "npx tinbase --engine pgmem &"?');
      return;
    }
    setTodos(data ?? []);
    setStatus((data?.length ?? 0) + ' todo(s) · tinbase (Postgres) in the Lifo VM');
  }

  useEffect(() => { refresh(); }, []);

  async function add() {
    const t = title.trim();
    if (!t) return;
    setTitle('');
    await supabase.from('todos').insert({ title: t });
    refresh();
  }

  async function toggle(todo) {
    await supabase.from('todos').update({ done: !todo.done }).eq('id', todo.id);
    refresh();
  }

  async function remove(todo) {
    await supabase.from('todos').delete().eq('id', todo.id);
    refresh();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>📝 Todos</Text>
      <Text style={styles.status}>{status}</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
          placeholderTextColor="#565f89"
          onSubmitEditing={add}
        />
        <Pressable style={styles.addBtn} onPress={add}>
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>
      <FlatList
        data={todos}
        keyExtractor={(t) => String(t.id)}
        renderItem={({ item }) => (
          <View style={styles.item}>
            <Pressable style={styles.itemBody} onPress={() => toggle(item)}>
              <Text style={styles.check}>{item.done ? '☑' : '☐'}</Text>
              <Text style={[styles.itemText, item.done && styles.itemDone]}>{item.title}</Text>
            </Pressable>
            <Pressable onPress={() => remove(item)} hitSlop={8}>
              <Text style={styles.del}>✕</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, maxWidth: 560, width: '100%', alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: '#c0caf5', marginBottom: 4 },
  status: { fontSize: 12, color: '#565f89', marginBottom: 16 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  input: {
    flex: 1, borderWidth: 1, borderColor: '#292e42', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, color: '#c0caf5', fontSize: 15,
  },
  addBtn: {
    backgroundColor: '#3ecf8e', borderRadius: 8, paddingHorizontal: 16,
    justifyContent: 'center',
  },
  addBtnText: { color: '#05291b', fontWeight: '700' },
  item: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#292e42',
  },
  itemBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: { fontSize: 16, color: '#7aa2f7' },
  itemText: { color: '#c0caf5', fontSize: 15, flex: 1 },
  itemDone: { textDecorationLine: 'line-through', color: '#565f89' },
  del: { color: '#f7768e', fontSize: 14, fontWeight: '700', paddingHorizontal: 6 },
});
`;

	// Boot the Expo web dev server (Metro) with Fast Refresh. Portable: on a real
	// machine this is equivalent to \`expo start --web\`; the Lifo-specific
	// adaptations only apply when os.platform() === 'lifo'.
	files[`${root}/start.mjs`] = `import os from 'os';
const isLifo = os.platform() === 'lifo';

process.env.NODE_ENV = 'development';
process.env.EXPO_NO_TELEMETRY = '1';

if (isLifo) {
  process.env.EXPO_OFFLINE = '1';
  process.env.BROWSER = 'none';    // the preview iframe IS the browser
  process.env.EXPO_NO_DEPENDENCY_VALIDATION = '1'; // skip the version doctor check

  // Metro's efficient recursive watcher is gated to macOS; Lifo's fs.watch
  // supports { recursive: true }, so force the native watcher (Fast Refresh).
  try {
    const nw = await import('metro-file-map/src/watchers/NativeWatcher.js');
    const NativeWatcher = nw.default ?? nw;
    NativeWatcher.isSupported = () => true;
  } catch (e) { console.warn('[lifo] NativeWatcher patch failed (no Fast Refresh):', e && e.message); }
}

const { expoStart } = await import('@expo/cli/build/src/start/index.js');
await expoStart([process.cwd(), '--web', '--port', '8083']);
console.log('\\nMetro dev server on http://localhost:8083 — open the App preview tab.');
await new Promise(() => {}); // keep the dev server alive
`;

	// ── supabase/ — a real Supabase project layout (config + migrations + seed) ──
	// `npx tinbase` reads migrations/ and seed.sql from here, mirroring how the
	// Supabase CLI applies them. Edit these files to evolve the schema.

	files[`${root}/supabase/config.toml`] = `# Supabase project config — https://supabase.com/docs/guides/cli/config
# In Lifo the tinbase CLI (\`npx tinbase\`) reads supabase/migrations + seed.sql
# and serves the Supabase-compatible API + Studio together on port 54321.
project_id = "expo-supabase-todo"

[api]
enabled = true
port = 54321
schemas = ["public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 54322
major_version = 15

[studio]
enabled = true
port = 54323

[auth]
enabled = true
`;

	files[`${root}/supabase/migrations/20240101000000_create_todos.sql`] = `-- Create the todos table.
create table if not exists todos (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
`;

	files[`${root}/supabase/seed.sql`] = `-- Seed data, applied after migrations (like \`supabase db reset\`).
insert into todos (title, done) values
  ('Edit supabase/migrations to change the schema', false),
  ('Add seed rows in supabase/seed.sql', true);
`;

	files[`${root}/README.txt`] = `Expo Router + Supabase (tinbase) — full-stack mobile, entirely in the Lifo VM
============================================================================

An Expo Router (React Native for Web) app on a live Metro dev server, talking to
a real Supabase-compatible backend (tinbase) over supabase-js — no Docker, no
cloud, nothing outside your browser.

Getting started
---------------
  npm install
  npx tinbase --engine pgmem &   # backend on :54321 (like \`supabase start\`)
  npm start                      # Expo/Metro dev server on :8083

Then open the preview tabs:
  - App     — the todo app (Metro, port 8083, with Fast Refresh)
  - Studio  — tinbase's admin dashboard at /_/ (table editor, SQL, auth, logs)

The backend
-----------
\`npx tinbase\` is the Supabase-compatible backend CLI (REST, auth, realtime,
Studio). Engine choices in Lifo:
  --engine pgmem           pure-JS Postgres — instant, recommended (used here)
  --engine wasm --memory   real Postgres (PGlite/wasm), in-memory
\`--engine wasm\` with on-disk persistence isn't supported in the VM yet (it
preallocates Postgres files the in-memory filesystem can't back).

Schema + seed live in a standard supabase/ folder, applied like \`supabase db reset\`:
  supabase/config.toml   — project config
  supabase/migrations/   — *.sql, applied in filename order
  supabase/seed.sql      — rows inserted after migrations
Edit the SQL and restart the backend to re-apply.

The app
-------
lib/supabase.js creates the supabase-js client from .env — exactly like a real
Expo project (EXPO_PUBLIC_* vars are inlined by Metro). The only Lifo-specific
bit is the URL:
  EXPO_PUBLIC_SUPABASE_URL=/_sw/54321
which the service worker routes to the in-VM backend.
`;

	return files;
}
