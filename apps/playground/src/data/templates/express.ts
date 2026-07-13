/* Node.js + Express VFS seed files: a small todo API + a static frontend that
 * talks to it, so the preview browser shows a real backend running in the VM. */
export function expressAppFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};

  files[`${root}/package.json`] = JSON.stringify({
    name: root.split('/').pop(),
    version: '1.0.0',
    private: true,
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.21.2' },
  }, null, 2);

  files[`${root}/server.js`] = `const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

// In-memory data — proves real server state across requests.
let todos = [
  { id: 1, text: 'Run Express inside Lifo', done: true },
  { id: 2, text: 'Add a todo below', done: false },
];
let nextId = 3;

// --- JSON API ---
app.get('/api/todos', (req, res) => {
  res.json(todos);
});

app.post('/api/todos', (req, res) => {
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const todo = { id: nextId++, text, done: false };
  todos.push(todo);
  res.status(201).json(todo);
});

app.post('/api/todos/:id/toggle', (req, res) => {
  const todo = todos.find((t) => t.id === Number(req.params.id));
  if (!todo) return res.status(404).json({ error: 'not found' });
  todo.done = !todo.done;
  res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
  todos = todos.filter((t) => t.id !== Number(req.params.id));
  res.status(204).end();
});

// --- Static frontend ---
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Express server running at http://localhost:' + PORT);
});
`;

  files[`${root}/public/index.html`] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Express Todos · Lifo</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1a1b26; }
    h1 { font-size: 1.4rem; }
    .sub { color: #565f89; font-size: 0.85rem; margin-top: -0.5rem; }
    form { display: flex; gap: 0.5rem; margin: 1.25rem 0; }
    input { flex: 1; padding: 0.6rem 0.75rem; border: 1px solid #c0caf5; border-radius: 8px; font-size: 1rem; }
    button { padding: 0.6rem 1rem; border: 0; border-radius: 8px; background: #7aa2f7; color: #fff; font-size: 0.95rem; cursor: pointer; }
    ul { list-style: none; padding: 0; }
    li { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.25rem; border-bottom: 1px solid #eaecf5; }
    li .txt { flex: 1; cursor: pointer; }
    li.done .txt { text-decoration: line-through; color: #9aa5ce; }
    li .del { background: transparent; color: #f7768e; padding: 0.2rem 0.5rem; }
  </style>
</head>
<body>
  <h1>📝 Express Todos</h1>
  <p class="sub">Served by a Node.js + Express server running inside the VM.</p>
  <form id="add"><input id="text" placeholder="What needs doing?" autocomplete="off" /><button>Add</button></form>
  <ul id="list"></ul>

  <script>
    const list = document.getElementById('list');
    const api = (url, opts) => fetch(url, opts).then((r) => (r.status === 204 ? null : r.json()));

    async function render() {
      const todos = await api('/api/todos');
      list.innerHTML = '';
      for (const t of todos) {
        const li = document.createElement('li');
        if (t.done) li.className = 'done';
        const txt = document.createElement('span');
        txt.className = 'txt';
        txt.textContent = t.text;
        txt.onclick = async () => { await api('/api/todos/' + t.id + '/toggle', { method: 'POST' }); render(); };
        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '✕';
        del.onclick = async () => { await api('/api/todos/' + t.id, { method: 'DELETE' }); render(); };
        li.append(txt, del);
        list.appendChild(li);
      }
    }

    document.getElementById('add').onsubmit = async (e) => {
      e.preventDefault();
      const input = document.getElementById('text');
      const text = input.value.trim();
      if (!text) return;
      await api('/api/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      input.value = '';
      render();
    };

    render();
  </script>
</body>
</html>
`;

  return files;
}
