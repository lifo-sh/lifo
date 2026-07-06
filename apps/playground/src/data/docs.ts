/* Docs-example HTML blocks (cli / lifo-pkg / build-pkg), moved verbatim from the old main.ts. */

export const DOC_CLI = `\
<span style="color:#7aa2f7;font-weight:bold">Lifo CLI</span> <span style="color:#565f89">-- run a Linux-like shell in your terminal</span>

<span style="color:#bb9af7">Install:</span>
  <span style="color:#9ece6a">npm install -g lifo-sh</span>

<span style="color:#bb9af7">Usage:</span>

  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo-sh</span>
  <span style="color:#565f89">  Starts a temp session. Files are stored in a temporary</span>
  <span style="color:#565f89">  directory and cleaned up when you exit.</span>

  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo-sh</span> <span style="color:#ff9e64">--mount</span> <span style="color:#9ece6a">~/projects/my-app</span>
  <span style="color:#565f89">  Mounts a host directory at /mnt/host. Your PWD starts</span>
  <span style="color:#565f89">  there. All file operations go directly to disk via</span>
  <span style="color:#565f89">  NativeFsProvider -- no memory limits on file size.</span>

  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo-sh</span> <span style="color:#ff9e64">-m</span> <span style="color:#9ece6a">/tmp</span>
  <span style="color:#565f89">  Short form of --mount.</span>

<span style="color:#bb9af7">What you get:</span>
  <span style="color:#9ece6a">60+</span> built-in commands (ls, grep, git, node, curl...)
  Shell scripting (if/for/while/case/functions/pipes)
  Node.js compatibility (require, fs, path, http...)
  <span style="color:#9ece6a">Real filesystem</span> access via --mount

<span style="color:#bb9af7">Example session:</span>
<span style="color:#3b4261">  ┌─────────────────────────────────────────────┐</span>
<span style="color:#3b4261">  │</span> <span style="color:#c0caf5">$ npx lifo-sh --mount ~/projects/my-app</span>     <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>                                              <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> <span style="color:#565f89">Mounted: ~/projects/my-app -> /mnt/host</span>     <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> <span style="color:#9ece6a">user@lifo</span>:<span style="color:#7aa2f7">/mnt/host</span>$ ls                     <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>   package.json  src/  README.md              <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> <span style="color:#9ece6a">user@lifo</span>:<span style="color:#7aa2f7">/mnt/host</span>$ cat package.json       <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>   { "name": "my-app", ... }                  <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> <span style="color:#9ece6a">user@lifo</span>:<span style="color:#7aa2f7">/mnt/host</span>$ echo "test" > new.txt  <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> <span style="color:#9ece6a">user@lifo</span>:<span style="color:#7aa2f7">/mnt/host</span>$ exit                  <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> logout                                       <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>                                              <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> <span style="color:#c0caf5">$ cat ~/projects/my-app/new.txt</span>             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span> test  <span style="color:#565f89"># file persisted to real disk!</span>        <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  └─────────────────────────────────────────────┘</span>

<span style="color:#bb9af7">Programmatic mounting (Node.js API):</span>
<span style="color:#565f89">  import { Sandbox, NativeFsProvider } from '@lifo-sh/core'</span>
<span style="color:#565f89">  import * as fs from 'node:fs'</span>
<span style="color:#565f89"></span>
<span style="color:#565f89">  const sandbox = await Sandbox.create()</span>
<span style="color:#565f89">  const provider = new NativeFsProvider('/my/dir', fs)</span>
<span style="color:#565f89">  sandbox.kernel.vfs.mount('/mnt/host', provider)</span>`;

export const DOC_LIFO_PKG = `\
<span style="color:#7aa2f7;font-weight:bold">lifo</span> <span style="color:#565f89">-- Lifo Package Manager</span>

<span style="color:#bb9af7">Overview:</span>
  The <span style="color:#7aa2f7">lifo</span> command installs packages that extend
  the OS with new commands. Packages live on npm
  with the prefix <span style="color:#9ece6a">lifo-pkg-*</span>.

<span style="color:#bb9af7">Install a package:</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo install</span> <span style="color:#9ece6a">git</span>
  <span style="color:#565f89">  Resolves to npm package: lifo-pkg-git</span>
  <span style="color:#565f89">  Downloads, extracts, and registers commands</span>

<span style="color:#bb9af7">What happens under the hood:</span>
<span style="color:#3b4261">  ┌──────────────────────────────────────────────┐</span>
<span style="color:#3b4261">  │</span> <span style="color:#c0caf5">lifo install git</span>                             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>   <span style="color:#565f89">1. Runs:</span> npm install -g lifo-pkg-git        <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>   <span style="color:#565f89">2. Reads "lifo" field from package.json</span>      <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>   <span style="color:#565f89">3. Registers commands with lifo runtime</span>      <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>   <span style="color:#565f89">4. Command available immediately</span>             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  └──────────────────────────────────────────────┘</span>

<span style="color:#bb9af7">Commands:</span>
  <span style="color:#7aa2f7">lifo install</span> <span style="color:#9ece6a">&lt;name&gt;</span>     Install lifo-pkg-&lt;name&gt; from npm
  <span style="color:#7aa2f7">lifo remove</span> <span style="color:#9ece6a">&lt;name&gt;</span>      Remove a package
  <span style="color:#7aa2f7">lifo list</span>               List installed packages + dev links
  <span style="color:#7aa2f7">lifo search</span> <span style="color:#9ece6a">&lt;term&gt;</span>      Search npm for lifo-pkg-* packages
  <span style="color:#7aa2f7">lifo init</span> <span style="color:#9ece6a">&lt;name&gt;</span>        Scaffold a new package
  <span style="color:#7aa2f7">lifo link</span> <span style="color:#9ece6a">[path]</span>        Dev-link a local package
  <span style="color:#7aa2f7">lifo unlink</span> <span style="color:#9ece6a">&lt;name&gt;</span>      Remove a dev link

<span style="color:#bb9af7">Lifo Runtime API:</span>
  <span style="color:#565f89">Lifo packages get an enhanced runtime with:</span>

  <span style="color:#7aa2f7">lifo.import</span>(specifier)    Import ESM from CDN
  <span style="color:#7aa2f7">lifo.loadWasm</span>(url)        Fetch + cache WASM modules
  <span style="color:#7aa2f7">lifo.resolve</span>(path)        Resolve path relative to cwd
  <span style="color:#7aa2f7">lifo.cdn</span>                  Current CDN URL

<span style="color:#bb9af7">Configuration:</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">export</span> LIFO_CDN=<span style="color:#9ece6a">https://esm.sh</span>  <span style="color:#565f89">(default)</span>
  <span style="color:#565f89">  Configure which CDN is used for lifo.import()</span>

<span style="color:#bb9af7">npm still works unchanged:</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">npm install -g</span> <span style="color:#9ece6a">cowsay</span>  <span style="color:#565f89">  Pure JS packages</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo install</span> <span style="color:#9ece6a">git</span>       <span style="color:#565f89">  Lifo-native packages</span>`;

export const DOC_BUILD_PKG = `\
<span style="color:#7aa2f7;font-weight:bold">Building Lifo Packages</span>

<span style="color:#bb9af7">Create a package (on your host machine):</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">npm create lifo-pkg</span> <span style="color:#9ece6a">my-tool</span>

  <span style="color:#565f89">Scaffolds a full TypeScript project:</span>
    lifo-pkg-my-tool/
      src/index.ts              <span style="color:#565f89"># command source (TypeScript)</span>
      example/                  <span style="color:#565f89"># Vite app for browser testing</span>
        index.html
        main.ts                 <span style="color:#565f89"># boots Kernel + Shell + your command</span>
      test-cli.js               <span style="color:#565f89"># CLI test harness (Node.js)</span>
      vite.config.ts            <span style="color:#565f89"># build config</span>
      package.json              <span style="color:#565f89"># with "lifo" field</span>

<span style="color:#bb9af7">Or quick-start inside the Lifo sandbox:</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo init</span> <span style="color:#9ece6a">my-tool</span>           <span style="color:#565f89"># CJS scaffold for dev-link</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo link</span> <span style="color:#9ece6a">./my-tool</span>         <span style="color:#565f89"># register locally</span>
  <span style="color:#c0caf5">$ </span>my-tool --help               <span style="color:#565f89"># test immediately</span>

<span style="color:#bb9af7">The "lifo" field in package.json:</span>
<span style="color:#3b4261">  ┌──────────────────────────────────────────────┐</span>
<span style="color:#3b4261">  │</span>  {                                             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    <span style="color:#7aa2f7">"name"</span>: <span style="color:#9ece6a">"lifo-pkg-my-tool"</span>,                <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    <span style="color:#7aa2f7">"lifo"</span>: {                                  <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>      <span style="color:#7aa2f7">"commands"</span>: {                             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>        <span style="color:#7aa2f7">"my-tool"</span>: <span style="color:#9ece6a">"./dist/index.js"</span>           <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>      }                                         <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    }                                            <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>  }                                              <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  └──────────────────────────────────────────────┘</span>

  <span style="color:#565f89">Any npm package with a "lifo" field and the</span>
  <span style="color:#565f89">prefix lifo-pkg-* is a lifo package.</span>

<span style="color:#bb9af7">Command source (TypeScript):</span>
<span style="color:#3b4261">  ┌──────────────────────────────────────────────┐</span>
<span style="color:#3b4261">  │</span>  <span style="color:#c0caf5">import type</span> { Command } <span style="color:#c0caf5">from</span> <span style="color:#9ece6a">'@lifo-sh/core'</span> <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>                                               <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>  <span style="color:#c0caf5">const</span> cmd: Command = <span style="color:#c0caf5">async</span> (ctx) => {        <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    ctx.stdout.write(<span style="color:#9ece6a">'Hello!\\n'</span>)               <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    <span style="color:#c0caf5">return</span> 0                                   <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>  }                                             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>  <span style="color:#c0caf5">export default</span> cmd                            <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  └──────────────────────────────────────────────┘</span>

<span style="color:#bb9af7">Or CJS (for lifo init / dev-link):</span>
<span style="color:#3b4261">  ┌──────────────────────────────────────────────┐</span>
<span style="color:#3b4261">  │</span>  module.exports = async function(ctx, lifo) { <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    <span style="color:#565f89">// lifo.import(), lifo.loadWasm()</span>          <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    ctx.stdout.write(<span style="color:#9ece6a">'Hello!\\n'</span>)               <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>    return 0                                    <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  │</span>  }                                             <span style="color:#3b4261">│</span>
<span style="color:#3b4261">  └──────────────────────────────────────────────┘</span>

<span style="color:#bb9af7">Testing your package:</span>

  <span style="color:#9ece6a">Browser</span> <span style="color:#565f89">(example Vite app included in scaffold)</span>
  <span style="color:#c0caf5">$ </span>npm run build
  <span style="color:#c0caf5">$ </span>npm run test:browser       <span style="color:#565f89"># opens terminal at localhost</span>

  <span style="color:#9ece6a">CLI</span> <span style="color:#565f89">(headless, no browser needed)</span>
  <span style="color:#c0caf5">$ </span>npm run test:cli -- --help <span style="color:#565f89"># runs command directly</span>

  <span style="color:#9ece6a">Dev-link</span> <span style="color:#565f89">(inside a running Lifo sandbox)</span>
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo link</span> <span style="color:#9ece6a">./my-tool</span>
  <span style="color:#c0caf5">$ </span>my-tool --help

<span style="color:#bb9af7">Using lifo.import() for dependencies:</span>
  <span style="color:#565f89">Load any npm package as ESM from CDN at runtime.</span>

  <span style="color:#c0caf5">const</span> { FFmpeg } = await lifo.<span style="color:#7aa2f7">import</span>(<span style="color:#9ece6a">'@ffmpeg/ffmpeg'</span>)
  <span style="color:#c0caf5">const</span> _ = await lifo.<span style="color:#7aa2f7">import</span>(<span style="color:#9ece6a">'lodash-es'</span>)

<span style="color:#bb9af7">Using lifo.loadWasm() for WASM:</span>
  <span style="color:#c0caf5">const</span> mod = await lifo.<span style="color:#7aa2f7">loadWasm</span>(<span style="color:#9ece6a">'https://...'</span>)
  <span style="color:#c0caf5">const</span> instance = await WebAssembly.<span style="color:#7aa2f7">instantiate</span>(mod)

<span style="color:#bb9af7">Publishing:</span>
  <span style="color:#c0caf5">$ </span>cd lifo-pkg-my-tool
  <span style="color:#c0caf5">$ </span>npm run build
  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">npm publish</span>

  <span style="color:#565f89">Users install with:</span>  <span style="color:#c0caf5">$ </span><span style="color:#7aa2f7">lifo install</span> <span style="color:#9ece6a">my-tool</span>

<span style="color:#bb9af7">Example: lifo-pkg-git</span>
  <span style="color:#565f89">Real-world lifo package powering the git command:</span>
  <span style="color:#565f89">  - TypeScript, exports Command type from @lifo-sh/core</span>
  <span style="color:#565f89">  - Depends on isomorphic-git</span>
  <span style="color:#565f89">  - Install: lifo install git</span>
  <span style="color:#565f89">  - Or import: import gitCommand from 'lifo-pkg-git'</span>`;
