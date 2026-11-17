# Files, persistence and snapshots

Every box has its own filesystem: a tree of directories and files in memory, laid out like a
small Linux system.

```
/
├── home/user/        $HOME, where a box starts
├── tmp/
├── etc/              profile, hostname, motd
├── usr/bin/          installed commands
├── usr/lib/node_modules/   global npm and Lifo packages
├── proc/             generated: uptime, memory, CPU, version
├── dev/              generated: null, zero, random, urandom
└── mnt/              host folders, when mounted
```

## Reading and writing from code

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.fs.mkdir('/home/user/notes', { recursive: true });
await box.fs.writeFile('/home/user/notes/todo.txt', 'ship the docs\n');
await box.fs.writeFiles([
  { path: '/home/user/notes/a.md', content: '# A' },
  { path: '/home/user/notes/b.md', content: '# B' },
]);

console.log(await box.fs.readdir('/home/user/notes'));
console.log(await box.fs.stat('/home/user/notes/todo.txt'));
console.log((await box.commands.run('grep -r ship /home/user/notes')).stdout);
```

`box.fs` has `readFile` (a string, or bytes with `readFile(path, null)`), `writeFile`,
`writeFiles`, `readdir`, `stat`, `exists`, `mkdir`, `rm`, `rename` and `cp`. `writeFiles`
doesn't create parent directories; `mkdir` them first. Programs in the box see the same files
through the shell and through Node's `fs`.

## Keeping files across reloads

In a browser, `Sandbox.create({ persist: true })` saves the filesystem to IndexedDB (debounced
as it changes) and restores it on the next visit. It's per origin and there's one store, so
two persisted boxes on the same site share their files. Without `persist`, every box starts
from a clean filesystem.

## Snapshots

A snapshot is a `.tar.gz` of a box: every file, plus a small manifest with the working
directory and the environment. One format works everywhere: `box.exportSnapshot()` in a page
or in Node, and `lifo-sh snapshot save` on the command line, all restore with
`box.importSnapshot()` or `lifo-sh snapshot restore`.

```js live
import { Sandbox } from '@lifo-sh/core';

const a = await Sandbox.create({ env: { GREETING: 'hello' } });
await a.commands.run('mkdir -p ~/app && cd ~/app && echo "console.log(process.env.GREETING)" > main.js');
a.cwd = '/home/user/app';

const snapshot = await a.exportSnapshot({ exclude: ['node_modules'] });
console.log(`snapshot: ${snapshot.byteLength} bytes`);

const b = await Sandbox.create();
const manifest = await b.importSnapshot(snapshot);
console.log('restored into', manifest.cwd);
console.log((await b.commands.run('node main.js')).stdout);
```

- `exclude` drops every file or folder with one of the given names, anywhere in the tree.
  Excluding `node_modules` makes snapshots small, and the restored box has to run
  `npm install` again.
- `metadata: false` writes files only, with no manifest.
- Restoring writes files over what's there and applies the snapshot's working directory and
  environment.

### Shipping a box with your site

`npm install` in a visitor's browser takes seconds. Do it once, ahead of time, and ship the
result: build the box in Node, install, export, and serve the `.tar.gz` with your site.

```js
// scripts/build-snapshot.mjs (run with node)
import { writeFile } from 'node:fs/promises';
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create({
  cwd: '/home/user/app',
  files: {
    '/home/user/app/package.json': JSON.stringify({
      name: 'app', type: 'module', scripts: { dev: 'vite' },
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^5.0.0' },
    }),
  },
});
await box.commands.run('npm install', { timeout: 300_000 });
await writeFile('public/snapshots/app.tar.gz', await box.exportSnapshot());
```

```js
// in the page
const box = await Sandbox.create();
await box.importSnapshot(new Uint8Array(await (await fetch('/snapshots/app.tar.gz')).arrayBuffer()));
await box.fs.writeFile('/home/user/app/src/App.jsx', generatedCode);   // your app's files
await box.commands.run('npm run dev &');
```

lifo.sh's landing page does exactly this: its Vite demo starts from a 4.8 MB snapshot.

## Folders from the host

In Node, a box can show a real folder at a path:

```js
const box = await Sandbox.create({
  mounts: [{ virtualPath: '/mnt/project', hostPath: process.cwd(), readOnly: true }],
});
```

Reads (and, without `readOnly`, writes) under `/mnt/project` go to the real folder. Mount
later with `box.mountNative(virtualPath, hostPath, { readOnly })`; remove with
`box.unmountNative(virtualPath)`. `lifo-sh --mount <dir>` does this at `/mnt/host`. Mounted
files are included in snapshots like any other.

## Files in SQLite

A folder can live in a SQLite database instead of memory, written through as it changes:

```js
import { DatabaseSync } from 'node:sqlite';
import { Sandbox, SqliteMountProvider, nodeSqlite } from '@lifo-sh/core';

const box = await Sandbox.create();
box.kernel.vfs.mount('/home', new SqliteMountProvider(nodeSqlite(new DatabaseSync('box.db'))));
```

Everything under `/home` is then in `box.db`: open it again in a new box, after a restart or a
crash, and the files are there, with their permissions, times and symbolic links. Lifo Cloud
uses the same provider over each box's own Durable Object database (`durableObjectSql`), so a
cloud box's files don't wait for a save.

- **When a write is safe.** Writes made during one turn of the event loop commit together when
  the turn ends (`provider.flush()` commits now). A crash loses at most the turn in progress,
  never a write from a turn that finished. With `nodeSqlite` the database uses WAL with
  `synchronous=NORMAL`: safe from a process crash; a power cut can lose the last commits.
- **Reads** come from a cache of recently used files (32 MB by default), then SQLite. Nothing is
  loaded up front, so mounting a large folder is instant.
- **Large files** (over 1 MB by default) are stored in chunks, shared between identical files.
- **Any SQL engine** that runs a query synchronously works: the provider takes a `SyncSql` with
  one method, `exec(query, ...params)`, returning rows.
- The mount starts empty. To move an existing folder into it, export a snapshot, mount, and
  import the snapshot (`importVfsSnapshot` writes through the mount).
