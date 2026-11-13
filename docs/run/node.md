# Lifo in Node.js

The same box that runs in a browser tab runs in a Node.js process: in a script, a test, a
server or a serverless function. A box boots in well under a millisecond once
`@lifo-sh/core` is loaded, so you can make one per request or per test.

```bash
npm install @lifo-sh/core
```

Node.js 20 or newer.

## Run commands

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create({
  files: { '/home/user/hello.js': 'console.log("hi from the box")' },
});

const { stdout, stderr, exitCode } = await box.commands.run('node hello.js && ls /home/user');
console.log(stdout);
```

The examples marked "runs in this page" on lifo.sh run in your browser: the API is the same
in both places.

`commands.run(line, options)` runs a full shell line and resolves with `stdout`, `stderr`
and `exitCode`. Options:

| Option | |
|---|---|
| `cwd`, `env` | for this command |
| `stdin` | text fed to the command's input |
| `onStdout`, `onStderr` | called with output as it's produced |
| `timeout` | milliseconds; the command is stopped and `exitCode` is 130 |
| `signal` | an `AbortSignal` that stops the command |

Values you pass in `env` currently stay set for later commands in the same box too. Don't
pass a secret to one command expecting the next one not to see it.

## Files

```js
await box.fs.writeFile('/home/user/data.json', JSON.stringify({ n: 1 }));
await box.fs.mkdir('/home/user/out', { recursive: true });
const text = await box.fs.readFile('/home/user/data.json');        // string
const bytes = await box.fs.readFile('/home/user/logo.png', null);  // Uint8Array
const entries = await box.fs.readdir('/home/user');                 // [{ name, type }]
```

Also `stat`, `exists`, `rm`, `rename`, `cp` and `writeFiles` (many at once; parent
directories must exist).

The box's filesystem lives in memory. To give it a folder from your disk, mount it:

```js
const box = await Sandbox.create({
  mounts: [{ virtualPath: '/mnt/project', hostPath: '/Users/me/project', readOnly: true }],
});
await box.commands.run('ls /mnt/project');
```

Reads and writes under `/mnt/project` go to the real folder (unless `readOnly`). You can also
mount later with `box.mountNative(virtualPath, hostPath)` and remove it with
`box.unmountNative(virtualPath)`.

## Servers in the box

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
await box.fs.writeFile('/home/user/server.js',
  `require('http').createServer((req, res) => res.end('ok ' + req.url)).listen(3000)`);
await box.commands.run('node server.js &');
await box.waitForPort(3000);

const res = await box.fetch('http://localhost:3000/ping');
console.log(res.status, await res.text());   // 200 ok /ping
```

The server listens on a port inside the box, not on your machine. `box.fetch` sends a
request to it and returns a normal `Response`; `box.connect(port, path)` opens a WebSocket to
it. An unbound port answers 404 rather than throwing. To put a box's port on a real port of
your machine, use the CLI's `--expose` (see [In your terminal](terminal.md)); to put it on a
public URL, `lifo tunnel`.

## Your own commands

Register a function as a command, and it works in the shell like any other: in pipes, in
scripts, from `node`'s `child_process`.

```js live
import { Sandbox } from '@lifo-sh/core';

const box = await Sandbox.create();
box.commands.register('greet', async (ctx) => {
  ctx.stdout.write(`hello, ${ctx.args[0] ?? 'world'}\n`);
  return 0;   // exit code
});

console.log((await box.commands.run('greet lifo | tr a-z A-Z')).stdout);   // HELLO, LIFO
```

`ctx` has `args`, `env`, `cwd`, `stdin`, `stdout`, `stderr`, `signal` and `vfs` (the box's
filesystem). This is how you give an agent a tool: register it, and the agent calls it from
the shell.

## Snapshots

```js
import { writeFile, readFile } from 'node:fs/promises';

// Save
await writeFile('box.tar.gz', await box.exportSnapshot({ exclude: ['node_modules'] }));

// Restore, here or in a browser
const copy = await Sandbox.create();
await copy.importSnapshot(new Uint8Array(await readFile('box.tar.gz')));
```

A snapshot holds the files, the working directory and the environment. It's the same format
the browser and the CLI use, so a common pattern is to build a box in Node (write a project,
run `npm install`, export it) and serve the snapshot to web pages, which then start with
everything installed.

`exclude` skips every file or folder with one of those names, anywhere in the tree
(`node_modules` drops all of them, not only the top one). Mounted folders are included like
any other files; exclude them by name (`exclude: ['project']`) if you don't want their
contents in the archive.

## Inside a test

```js
import { test, expect } from 'vitest';
import { Sandbox } from '@lifo-sh/core';

test('the CLI prints its version', async () => {
  const box = await Sandbox.create({ files: { '/home/user/cli.js': myCliSource } });
  const { stdout, exitCode } = await box.commands.run('node cli.js --version');
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/^\d+\.\d+\.\d+/);
});
```

A fresh box per test costs almost nothing and starts from a known filesystem.

## Security

A box is not a security boundary in Node either. Programs in it get their own filesystem,
processes and ports, but `node` runs their JavaScript in your process's own realm, where the
real `process`, `fs` and network are a line of code away. Use a box to run your own code, or
an agent's on your own machine. For code you don't trust, run the box in a separate process
or container with the permissions you'd give that code anyway.
