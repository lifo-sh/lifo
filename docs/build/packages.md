# Packages

There are two kinds of packages in a box: npm packages, which programs `require` and
`import`, and Lifo packages, which add commands to the shell.

## npm

`npm` in a box talks to the real npm registry and unpacks packages into the box's
filesystem.

```bash live
mkdir -p ~/demo && cd ~/demo
npm init -y > /dev/null
npm install ms
node -e "console.log(require('ms')('2 days'))"
npm ls
```

Supported: `install` (`i`, `add`), `uninstall` (`remove`, `rm`), `ls`, `run`, `start`, `test`, `init`, `pack`, `info` (`view`) and `search`.
`npm install -g <pkg>` puts the package's `bin` commands on the `PATH`, and `npx <pkg>` runs
one without installing it globally.

Things to know:

- Installs are real downloads. In a browser, ship a [snapshot](files.md#shipping-a-box-with-your-site)
  with `node_modules` already installed when you can.
- Packages that compile native code on install, or ship `.node` binaries, won't work, unless
  Lifo has a WebAssembly stand-in for them (esbuild, SWC, Rollup's parser, Tailwind's oxide).
- `NPM_REGISTRY` in the box's environment points npm at another registry or a proxy.

## Lifo packages

A Lifo package is an npm package that registers shell commands. Install one by name:

```bash
lifo install ffmpeg        # installs lifo-pkg-ffmpeg, adds `ffmpeg`
lifo list
lifo search git
lifo remove ffmpeg
```

`lifo install x` tries `lifo-pkg-x` first, then `x`. Published packages include `git`,
`ffmpeg` (WebAssembly), `nano`, `vi`, `less`, `man`, `cal`, `bc` and `fastfetch`, plus
[`python`](python.md) (CPython via Pyodide, with `pip`). `git`, `vi`, `nano`, `less` and
`python` are already there in `lifo-sh` and in the boxes on lifo.sh.

In your own boxes, register a package's command directly:

```js
import gitCommand from 'lifo-pkg-git';   // npm install lifo-pkg-git
box.commands.register('git', gitCommand);
```

## Writing a Lifo package

```bash
npm create lifo-pkg hello
```

A package exports a command, an `async (ctx) => exitCode` function, and names it in
`package.json`:

```json
{
  "name": "lifo-pkg-hello",
  "type": "module",
  "main": "dist/index.js",
  "lifo": { "commands": { "hello": "./dist/index.js" } },
  "keywords": ["lifo-pkg"]
}
```

```js
export default async function hello(ctx) {
  ctx.stdout.write(`hello, ${ctx.args[0] ?? 'world'} from ${ctx.cwd}\n`);
  return 0;
}
```

`ctx` gives the command its `args`, `env`, `cwd`, `stdin`, `stdout`, `stderr`, `signal` and
the box's filesystem (`vfs`). While developing, `lifo link <path>` makes a local package's
commands available without publishing; `lifo unlink <name>` removes the link. Publish to npm
with the `lifo-pkg` keyword and `lifo search` finds it.
