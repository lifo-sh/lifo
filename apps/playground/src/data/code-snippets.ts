/* Code-column snippets (pre-highlighted HTML), moved verbatim from the old main.ts. */
/* eslint-disable */
const CODE_INTERACTIVE = `\
<span class="code-keyword">import</span> { Terminal } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/ui'</span>
<span class="code-keyword">import</span> { Sandbox } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>

<span class="code-comment">// Create a terminal and attach it to a DOM element</span>
<span class="code-keyword">const</span> terminal = <span class="code-keyword">new</span> <span class="code-fn">Terminal</span>(
  document.<span class="code-fn">getElementById</span>(<span class="code-string">'terminal'</span>)
)

<span class="code-comment">// Boot a full interactive shell</span>
<span class="code-keyword">const</span> sandbox = <span class="code-keyword">await</span> Sandbox.<span class="code-fn">create</span>({
  <span class="code-const">persist</span>: <span class="code-keyword">true</span>,
  <span class="code-const">terminal</span>,
})

<span class="code-comment">// Helper: create a shell tab</span>
<span class="code-keyword">function</span> <span class="code-fn">createShell</span>(container) {
  <span class="code-keyword">const</span> term = <span class="code-keyword">new</span> <span class="code-fn">Terminal</span>(container)
  <span class="code-keyword">const</span> reg  = <span class="code-fn">createDefaultRegistry</span>()
  <span class="code-keyword">const</span> env  = kernel.<span class="code-fn">getDefaultEnv</span>()
  <span class="code-keyword">const</span> sh   = <span class="code-keyword">new</span> <span class="code-fn">Shell</span>(
    term, kernel.vfs, reg, env
  )
  sh.<span class="code-fn">start</span>()
  <span class="code-keyword">return</span> sh
}

<span class="code-comment">// Tabs share the same persistent VFS.</span>
<span class="code-comment">// State keeps across reloads.</span>
<span class="code-comment">// Click + to add more tabs.</span>`;

const CODE_HEADLESS = `\
<span class="code-keyword">import</span> { Sandbox } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>

<span class="code-comment">// Create a headless sandbox (no terminal UI)</span>
<span class="code-keyword">const</span> sandbox = <span class="code-keyword">await</span> Sandbox.<span class="code-fn">create</span>()

<span class="code-comment">// Run commands programmatically</span>
<span class="code-keyword">const</span> r1 = <span class="code-keyword">await</span> sandbox.commands.<span class="code-fn">run</span>(
  <span class="code-string">'echo "Hello from Lifo!"'</span>
)
console.<span class="code-fn">log</span>(r1.stdout)   <span class="code-comment">// "Hello from Lifo!\\n"</span>
console.<span class="code-fn">log</span>(r1.exitCode) <span class="code-comment">// 0</span>

<span class="code-comment">// Write files and read them back</span>
<span class="code-keyword">await</span> sandbox.fs.<span class="code-fn">writeFile</span>(
  <span class="code-string">'/home/user/app.js'</span>,
  <span class="code-string">'console.log("hi")'</span>
)
<span class="code-keyword">const</span> content = <span class="code-keyword">await</span> sandbox.fs.<span class="code-fn">readFile</span>(
  <span class="code-string">'/home/user/app.js'</span>
)

<span class="code-comment">// Pipes, variable expansion</span>
<span class="code-keyword">await</span> sandbox.commands.<span class="code-fn">run</span>(<span class="code-string">'export GREETING=world'</span>)
<span class="code-keyword">const</span> r2 = <span class="code-keyword">await</span> sandbox.commands.<span class="code-fn">run</span>(
  <span class="code-string">'echo $GREETING | cat'</span>
)

<span class="code-comment">// List files</span>
<span class="code-keyword">const</span> entries = <span class="code-keyword">await</span> sandbox.fs.<span class="code-fn">readdir</span>(
  <span class="code-string">'/home/user'</span>
)

sandbox.<span class="code-fn">destroy</span>()`;

const CODE_MULTI = `\
<span class="code-keyword">import</span> { Terminal } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/ui'</span>
<span class="code-keyword">import</span> {
  Kernel, Shell,
  createDefaultRegistry, <span class="code-comment">...</span>
} <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>

<span class="code-comment">// Boot one shared kernel</span>
<span class="code-keyword">const</span> kernel = <span class="code-keyword">new</span> <span class="code-fn">Kernel</span>()
<span class="code-keyword">await</span> kernel.<span class="code-fn">boot</span>()

<span class="code-comment">// Helper: create an interactive shell</span>
<span class="code-comment">// that shares the kernel's VFS</span>
<span class="code-keyword">function</span> <span class="code-fn">createShell</span>(container) {
  <span class="code-keyword">const</span> term = <span class="code-keyword">new</span> <span class="code-fn">Terminal</span>(container)
  <span class="code-keyword">const</span> reg  = <span class="code-fn">createDefaultRegistry</span>()
  <span class="code-keyword">const</span> env  = kernel.<span class="code-fn">getDefaultEnv</span>()
  <span class="code-keyword">const</span> sh   = <span class="code-keyword">new</span> <span class="code-fn">Shell</span>(
    term, kernel.vfs, reg, env
  )
  sh.<span class="code-fn">start</span>()
  <span class="code-keyword">return</span> sh
}

<span class="code-comment">// Each tab creates a new Shell on</span>
<span class="code-comment">// the same VFS. Files created in one</span>
<span class="code-comment">// terminal are visible in all others.</span>
<span class="code-fn">createShell</span>(document.<span class="code-fn">getElementById</span>(<span class="code-string">'t1'</span>))
<span class="code-fn">createShell</span>(document.<span class="code-fn">getElementById</span>(<span class="code-string">'t2'</span>))

<span class="code-comment">// Try: "touch /tmp/shared" in tab 1,</span>
<span class="code-comment">// then "ls /tmp" in tab 2.</span>`;

const CODE_HTTP = `\
<span class="code-keyword">import</span> { Terminal } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/ui'</span>
<span class="code-keyword">import</span> {
  Kernel, Shell,
  createDefaultRegistry,
  createNodeCommand, createCurlCommand, <span class="code-comment">...</span>
} <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>

<span class="code-comment">// Boot kernel -- portRegistry is shared</span>
<span class="code-keyword">const</span> kernel = <span class="code-keyword">new</span> <span class="code-fn">Kernel</span>()
<span class="code-keyword">await</span> kernel.<span class="code-fn">boot</span>()

<span class="code-comment">// Write a server script to the VFS</span>
kernel.vfs.<span class="code-fn">writeFile</span>(<span class="code-string">'/home/user/server.js'</span>, \`
  <span class="code-keyword">const</span> http = <span class="code-fn">require</span>(<span class="code-string">'http'</span>)
  <span class="code-keyword">const</span> server = http.<span class="code-fn">createServer</span>((req, res) => {
    res.<span class="code-fn">writeHead</span>(<span class="code-const">200</span>, { <span class="code-string">'Content-Type'</span>: <span class="code-string">'text/plain'</span> })
    res.<span class="code-fn">end</span>(<span class="code-string">'Hello from Lifo!\\n'</span>)
  })
  server.<span class="code-fn">listen</span>(<span class="code-const">3000</span>, () => {
    console.<span class="code-fn">log</span>(<span class="code-string">'Server running on port 3000'</span>)
  })
\`)

<span class="code-comment">// Register node &amp; curl with kernel</span>
registry.<span class="code-fn">register</span>(<span class="code-string">'node'</span>,
  <span class="code-fn">createNodeCommand</span>(kernel))
registry.<span class="code-fn">register</span>(<span class="code-string">'curl'</span>,
  <span class="code-fn">createCurlCommand</span>(kernel))

<span class="code-comment">// Tab 1: node server.js</span>
<span class="code-comment">// Tab 2: curl localhost:3000</span>
<span class="code-comment">// Tab 3: node server2.js (proxy to 3000)</span>
<span class="code-comment">//         curl localhost:3001</span>`;

const CODE_EXPLORER = `\
<span class="code-keyword">import</span> { Terminal, FileExplorer } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/ui'</span>
<span class="code-keyword">import</span> { Kernel, Shell, <span class="code-comment">...</span> } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>

<span class="code-keyword">const</span> kernel = <span class="code-keyword">new</span> <span class="code-fn">Kernel</span>()
<span class="code-keyword">await</span> kernel.<span class="code-fn">boot</span>()

<span class="code-comment">// File Explorer with Monaco editor</span>
<span class="code-keyword">const</span> explorer = <span class="code-keyword">new</span> <span class="code-fn">FileExplorer</span>(
  document.<span class="code-fn">getElementById</span>(<span class="code-string">'explorer'</span>),
  kernel.vfs,
  {
    <span class="code-const">cwd</span>: <span class="code-string">'/home/user'</span>,
    <span class="code-const">editorProvider</span>: monacoProvider,
  }
)

<span class="code-comment">// Terminal sharing the same VFS</span>
<span class="code-keyword">const</span> shell = <span class="code-keyword">new</span> <span class="code-fn">Shell</span>(
  term, kernel.vfs, registry, env
)
shell.<span class="code-fn">start</span>()

<span class="code-comment">// Changes sync live between</span>
<span class="code-comment">// terminal and explorer.</span>
<span class="code-comment">// Drag &amp; drop files to upload.</span>`;

const CODE_GIT = `\
<span class="code-comment">// ── Option 1: Install in host app ──</span>
<span class="code-keyword">import</span> gitCommand <span class="code-keyword">from</span> <span class="code-string">'lifo-pkg-git'</span>

<span class="code-keyword">const</span> registry = <span class="code-fn">createDefaultRegistry</span>()
registry.<span class="code-fn">register</span>(<span class="code-string">'git'</span>, gitCommand)

<span class="code-comment">// ── Option 2: Install inside sandbox ──</span>
<span class="code-comment">// In the terminal, run:</span>
<span class="code-string">lifo add git</span>

<span class="code-comment">// Both give you the same git command.</span>
<span class="code-comment">// Try these:</span>
<span class="code-string">mkdir /tmp/my-project && cd /tmp/my-project</span>
<span class="code-string">git init</span>
<span class="code-string">echo "# My App" > README.md</span>
<span class="code-string">git add .</span>
<span class="code-string">git commit -m "Initial commit"</span>
<span class="code-string">git branch feature</span>
<span class="code-string">git checkout feature</span>
<span class="code-string">echo "new feature" > feature.js</span>
<span class="code-string">git add . && git commit -m "Add feature"</span>
<span class="code-string">git log --oneline</span>`;

const CODE_FFMPEG = `\
<span class="code-comment">// ── Option 1: Install in host app ──</span>
<span class="code-keyword">import</span> ffmpegCommand <span class="code-keyword">from</span> <span class="code-string">'lifo-pkg-ffmpeg'</span>

<span class="code-keyword">const</span> registry = <span class="code-fn">createDefaultRegistry</span>()
registry.<span class="code-fn">register</span>(<span class="code-string">'ffmpeg'</span>, ffmpegCommand)

<span class="code-comment">// ── Option 2: Install inside sandbox ──</span>
<span class="code-comment">// In the terminal, run:</span>
<span class="code-string">lifo add ffmpeg</span>

<span class="code-comment">// Upload files via drag &amp; drop or terminal.</span>
<span class="code-comment">// Right-click to download results.</span>
<span class="code-comment">// Try these commands:</span>
<span class="code-string">cd media</span>
<span class="code-string">ffmpeg -i sample.mp4 audio.mp3</span>
<span class="code-string">ffmpeg -i sample.mp4 -ss 0 -t 3 clip.mp4</span>
<span class="code-string">ffmpeg -i sample.mp4 -vf scale=320:-1 sm.mp4</span>
<span class="code-string">ffmpeg -version</span>`;

const CODE_NPM = `\
<span class="code-keyword">import</span> { Terminal } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/ui'</span>
<span class="code-keyword">import</span> { Sandbox } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>

<span class="code-comment">// Create a terminal and boot a shell</span>
<span class="code-keyword">const</span> terminal = <span class="code-keyword">new</span> <span class="code-fn">Terminal</span>(
  document.<span class="code-fn">getElementById</span>(<span class="code-string">'terminal'</span>)
)
<span class="code-keyword">const</span> sandbox = <span class="code-keyword">await</span> Sandbox.<span class="code-fn">create</span>({ <span class="code-const">terminal</span> })

<span class="code-comment">// Try these in the terminal:</span>

<span class="code-comment">// Install a package globally</span>
<span class="code-string">npm install cowsay -g</span>

<span class="code-comment">// Run it!</span>
<span class="code-string">cowsay "Hello from Lifo!"</span>

<span class="code-comment">// Or create a project</span>
<span class="code-string">mkdir /tmp/my-app && cd /tmp/my-app</span>
<span class="code-string">npm init -y</span>
<span class="code-string">npm install cowsay</span>
<span class="code-string">cat node_modules/cowsay/package.json</span>

<span class="code-comment">// Packages are fetched from the real</span>
<span class="code-comment">// npm registry, extracted, and installed</span>
<span class="code-comment">// into the virtual filesystem.</span>
<span class="code-comment">// Dependencies are resolved recursively.</span>`;

const CODE_LIFO_PKG = `\
<span class="code-comment">// The lifo command manages packages</span>
<span class="code-comment">// that extend the OS with new commands</span>

<span class="code-comment">// Install a package (from npm: lifo-pkg-*)</span>
<span class="code-string">lifo install git</span>
<span class="code-string">lifo install ffmpeg</span>

<span class="code-comment">// Use it immediately</span>
<span class="code-string">git init</span>

<span class="code-comment">// List installed lifo packages</span>
<span class="code-string">lifo list</span>

<span class="code-comment">// Search npm for lifo packages</span>
<span class="code-string">lifo search postgres</span>

<span class="code-comment">// Remove a package</span>
<span class="code-string">lifo remove git</span>

<span class="code-comment">// How it works:</span>
<span class="code-comment">//   lifo install git</span>
<span class="code-comment">//   -> npm install -g lifo-pkg-git</span>
<span class="code-comment">//   -> reads "lifo" field from package.json</span>
<span class="code-comment">//   -> registers commands with lifo runtime</span>
<span class="code-comment">//</span>
<span class="code-comment">// Packages get access to:</span>
<span class="code-comment">//   ctx  - CommandContext (args, vfs, stdout...)</span>
<span class="code-comment">//   lifo - LifoAPI (import(), loadWasm()...)</span>

<span class="code-comment">// Configure CDN for ESM imports</span>
<span class="code-string">export LIFO_CDN=https://esm.sh</span>`;

const CODE_BUILD_PKG = `\
<span class="code-comment">// Create a new lifo package</span>
<span class="code-string">lifo init my-tool</span>
<span class="code-comment">// Creates:</span>
<span class="code-comment">//   my-tool/package.json     (with lifo field)</span>
<span class="code-comment">//   my-tool/commands/my-tool.js</span>
<span class="code-comment">//   my-tool/README.md</span>

<span class="code-comment">// The package.json lifo field:</span>
{
  <span class="code-string">"name"</span>: <span class="code-string">"lifo-pkg-my-tool"</span>,
  <span class="code-string">"lifo"</span>: {
    <span class="code-string">"commands"</span>: {
      <span class="code-string">"my-tool"</span>: <span class="code-string">"./commands/my-tool.js"</span>
    }
  }
}

<span class="code-comment">// Command entry (CJS module):</span>
module.exports = <span class="code-keyword">async function</span>(ctx, lifo) {
  <span class="code-comment">// ctx.args   - command arguments</span>
  <span class="code-comment">// ctx.vfs    - virtual filesystem</span>
  <span class="code-comment">// ctx.stdout - write output</span>
  <span class="code-comment">// ctx.stderr - write errors</span>
  <span class="code-comment">// ctx.cwd    - current directory</span>
  <span class="code-comment">// ctx.env    - environment variables</span>
  <span class="code-comment">// ctx.signal - AbortSignal</span>

  <span class="code-comment">// lifo.import() loads ESM from CDN</span>
  <span class="code-keyword">const</span> lib = <span class="code-keyword">await</span> lifo.<span class="code-fn">import</span>(<span class="code-string">'lodash-es'</span>)

  <span class="code-comment">// lifo.loadWasm() fetches + caches WASM</span>
  <span class="code-keyword">const</span> mod = <span class="code-keyword">await</span> lifo.<span class="code-fn">loadWasm</span>(url)

  ctx.stdout.<span class="code-fn">write</span>(<span class="code-string">'Hello!\\n'</span>)
  <span class="code-keyword">return</span> <span class="code-const">0</span>  <span class="code-comment">// exit code</span>
}

<span class="code-comment">// Dev workflow:</span>
<span class="code-string">lifo link ./my-tool</span>    <span class="code-comment"># register locally</span>
<span class="code-string">my-tool --help</span>         <span class="code-comment"># test it</span>
<span class="code-string">lifo unlink my-tool</span>    <span class="code-comment"># remove link</span>

<span class="code-comment">// Publish to npm:</span>
<span class="code-string">cd my-tool && npm publish</span>
<span class="code-comment">// Users install with: lifo install my-tool</span>`;

const CODE_CLI = `\
<span class="code-comment">// Run Lifo as a CLI in your terminal</span>
<span class="code-comment">// Install: npm i -g lifo-sh</span>

<span class="code-comment">// Temp session (files cleaned up on exit)</span>
$ <span class="code-fn">npx</span> <span class="code-string">lifo-sh</span>

<span class="code-comment">// Mount a host directory for real file I/O</span>
$ <span class="code-fn">npx</span> <span class="code-string">lifo-sh</span> <span class="code-keyword">--mount</span> <span class="code-string">~/projects/my-app</span>

<span class="code-comment">// Files are accessible at /mnt/host</span>
<span class="code-comment">// Your PWD starts there automatically</span>
user@lifo:/mnt/host$ <span class="code-fn">ls</span>
  package.json  src/  README.md

<span class="code-comment">// Expose an in-VM server to your real browser.</span>
<span class="code-comment">// The CLI has no service worker, so it tunnels</span>
<span class="code-comment">// through a relay instead:</span>
$ <span class="code-fn">npx</span> <span class="code-string">lifo-sh tunnel</span> <span class="code-string">5173</span>
<span class="code-comment">// → serves the VM's port 5173 at http://localhost:3005</span>
<span class="code-comment">// (in the browser playground you don't need this —</span>
<span class="code-comment">//  the service worker serves /_sw/5173/ directly)</span>

<span class="code-comment">// All changes go directly to disk</span>
user@lifo:/mnt/host$ <span class="code-fn">echo</span> <span class="code-string">"hello"</span> > test.txt
<span class="code-comment">// test.txt now exists on your real FS!</span>

<span class="code-comment">// Programmatic usage (Node.js)</span>
<span class="code-keyword">import</span> { Sandbox } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>
<span class="code-keyword">import</span> { NativeFsProvider } <span class="code-keyword">from</span> <span class="code-string">'@lifo-sh/core'</span>
<span class="code-keyword">import</span> * <span class="code-keyword">as</span> fs <span class="code-keyword">from</span> <span class="code-string">'node:fs'</span>

<span class="code-keyword">const</span> sandbox = <span class="code-keyword">await</span> Sandbox.<span class="code-fn">create</span>()

<span class="code-comment">// Mount your project directory</span>
<span class="code-keyword">const</span> provider = <span class="code-keyword">new</span> <span class="code-fn">NativeFsProvider</span>(
  <span class="code-string">'/home/user/project'</span>, fs
)
sandbox.kernel.vfs.<span class="code-fn">mount</span>(
  <span class="code-string">'/mnt/host'</span>, provider
)

<span class="code-comment">// Now VFS reads/writes hit real disk</span>
<span class="code-keyword">await</span> sandbox.commands.<span class="code-fn">run</span>(
  <span class="code-string">'ls /mnt/host'</span>
)`;

const CODE_VITE_REACT = `\
<span class="code-comment"># A real Vite dev server with React fast-refresh,</span>
<span class="code-comment"># running entirely in your browser — no host process.</span>

<span class="code-fn">npm</span> install          <span class="code-comment"># real npm registry, in-browser</span>
<span class="code-fn">npm</span> run dev &        <span class="code-comment"># vite on virtual port 5173</span>

<span class="code-comment"># the preview pane (below the terminal) is an iframe</span>
<span class="code-comment"># pointed at /_sw/5173/ — served by a service worker</span>
<span class="code-comment"># straight from the VM. Click "Reload" once vite is up.</span>

<span class="code-fn">sed</span> -i <span class="code-string">'s/React inside Lifo/Hello HMR/'</span> src/App.jsx
<span class="code-comment"># the preview hot-updates via react-refresh —</span>
<span class="code-comment"># click the counter first and watch state survive</span>`;

const CODE_VITE_REACT_TS = `\
<span class="code-comment"># Vite + React + TypeScript, same stack as the JS</span>
<span class="code-comment"># example: tsx transforms, fast-refresh, all in-browser.</span>

<span class="code-fn">npm</span> install
<span class="code-fn">npm</span> run dev &

<span class="code-comment"># preview pane → /_sw/5173/ (service-worker transport)</span>
<span class="code-fn">sed</span> -i <span class="code-string">'s/React inside Lifo/Hello HMR/'</span> src/App.tsx`;

const CODE_CREATE_VITE = `\
<span class="code-comment"># Prove it's the real Vite: scaffold an untouched app</span>
<span class="code-comment"># with create-vite and run it 1:1 — its own vite.config.js,</span>
<span class="code-comment"># its own scripts, zero Lifo-specific changes.</span>

<span class="code-fn">npx</span> create-vite@7.1.3 my-app --template react
<span class="code-fn">cd</span> my-app
<span class="code-fn">npm</span> install
<span class="code-fn">npm</span> run dev &

<span class="code-comment"># the preview pane loads /_sw/5173/ — the scaffolded</span>
<span class="code-comment"># app served by unmodified Vite from inside your browser,</span>
<span class="code-comment"># HMR and all, with no host process. The service worker</span>
<span class="code-comment"># tunnels HTTP + WebSocket frames to the in-VM server.</span>`;

const CODE_TINBASE = `\
<span class="code-comment"># Local Supabase-style dev, entirely in Lifo: tinbase</span>
<span class="code-comment"># (tinbase.vercel.app) runs as a server IN the VM, and a</span>
<span class="code-comment"># Vite + React + TS app talks to it via supabase-js.</span>

<span class="code-fn">npm</span> install
<span class="code-fn">npm</span> run backend &   <span class="code-comment"># tinbase on :54321 (like supabase start)</span>
<span class="code-fn">npm</span> run dev &       <span class="code-comment"># vite + react on :5173</span>

<span class="code-comment"># .env — just like a real Supabase project:</span>
<span class="code-comment">#   VITE_SUPABASE_URL=/_sw/54321</span>
<span class="code-comment">#   VITE_SUPABASE_ANON_KEY=eyJhbGci...</span>

<span class="code-keyword">const</span> supabase = <span class="code-fn">createClient</span>(url, anonKey)
<span class="code-keyword">await</span> supabase.<span class="code-fn">from</span>(<span class="code-string">'todos'</span>).<span class="code-fn">insert</span>({ title })

<span class="code-comment"># test HMR: edit the heading, keep your typed input —</span>
<span class="code-fn">sed</span> -i <span class="code-string">'s/📝 Todos/✅ My Tasks/'</span> src/App.tsx
<span class="code-comment"># react-refresh hot-updates the preview, state intact;</span>
<span class="code-comment"># todos persist too (they live in the backend process).</span>`;

const CODE_PGLITE = `\
<span class="code-comment"># PostgreSQL compiled to wasm (PGlite), running in the VM</span>

<span class="code-fn">npm</span> install          <span class="code-comment"># @electric-sql/pglite</span>
<span class="code-fn">node</span> test.mjs        <span class="code-comment"># DB + RLS + jsonb tests</span>

<span class="code-comment"># test.mjs boots postgres, creates a table, enables</span>
<span class="code-comment"># ROW LEVEL SECURITY and verifies policy-filtered</span>
<span class="code-comment"># queries via SET ROLE — real postgres semantics:</span>

<span class="code-keyword">ALTER TABLE</span> docs <span class="code-keyword">ENABLE ROW LEVEL SECURITY</span>;
<span class="code-keyword">CREATE POLICY</span> own_docs <span class="code-keyword">ON</span> docs
  <span class="code-keyword">FOR SELECT USING</span> (owner = current_user);
<span class="code-keyword">SET ROLE</span> alice;
<span class="code-keyword">SELECT</span> body <span class="code-keyword">FROM</span> docs;  <span class="code-comment">-- only alice's rows</span>`;

const CODE_EXPO = `\
<span class="code-comment"># A real Expo (React Native for Web) app on a live</span>
<span class="code-comment"># Metro dev server, running entirely in your browser.</span>
<span class="code-comment"># Metro runs in-band (maxWorkers=1) and offline.</span>

<span class="code-fn">npm</span> install          <span class="code-comment"># expo, react-native, metro, …</span>
<span class="code-fn">npm</span> run start &      <span class="code-comment"># expo start --web → Metro dev server :8081</span>

<span class="code-comment"># the preview pane (below) is an iframe at /_sw/8081/,</span>
<span class="code-comment"># served by a service worker straight from the VM.</span>
<span class="code-comment"># Fast Refresh: edit App.js and save — updates in place</span>
<span class="code-comment"># (HMR websocket rides the same service-worker shim as Vite).</span>
<span class="code-fn">sed</span> -i <span class="code-string">'s/Expo inside Lifo/Hello Metro/'</span> App.js`;

const CODE_EXPO_ROUTER = `\
<span class="code-comment"># Expo Router — file-based routing on a live Metro dev</span>
<span class="code-comment"># server, running entirely in your browser.</span>
<span class="code-comment"># Routes live in app/ (app/index.js, app/about.js).</span>

<span class="code-fn">npm</span> install          <span class="code-comment"># expo-router, react-navigation, …</span>
<span class="code-fn">npm</span> run start &      <span class="code-comment"># expo start --web → Metro dev server :8082</span>

<span class="code-comment"># preview pane → /_sw/8082/ (service-worker transport).</span>
<span class="code-comment"># click "Go to About" — client-side routing, no reload.</span>
<span class="code-comment"># Fast Refresh: edit app/index.js and save — updates in</span>
<span class="code-comment"># place (HMR rides the same service-worker shim as Vite).</span>`;

const CODE_CREATE_EXPO_APP = `\
<span class="code-comment"># Prove it's the real Expo: scaffold an untouched app</span>
<span class="code-comment"># with create-expo-app and run it 1:1 — stock metro</span>
<span class="code-comment"># config, stock router, zero Lifo-specific changes.</span>

<span class="code-fn">npx</span> create-expo-app@latest my-app --template blank
<span class="code-comment">#   ↳ pick an SDK at the prompt (Enter = latest)</span>
<span class="code-fn">cd</span> my-app
<span class="code-fn">npx</span> expo install react-dom react-native-web
<span class="code-fn">npx</span> expo start --web     <span class="code-comment"># Metro dev server :8081</span>

<span class="code-comment"># preview pane → the app, served from inside your browser.</span>
<span class="code-comment"># the default template works too (drop --template blank):</span>
<span class="code-comment"># Expo Router tabs + static rendering (SSR), unmodified.</span>

<span class="code-comment"># note: create-expo-app + expo start call api.expo.dev,</span>
<span class="code-comment"># which needs the relay as a CORS proxy:</span>
<span class="code-comment">#   node apps/tunnel-server/server.js   (on your machine)</span>`;

const CODE_EXPO_SUPABASE = `\
<span class="code-comment"># Expo Router + Supabase, both entirely in the VM: a React</span>
<span class="code-comment"># Native web app (Metro + Fast Refresh) talking supabase-js</span>
<span class="code-comment"># to a tinbase backend (pure-JS Postgres via pg-mem).</span>

<span class="code-fn">npm</span> install
<span class="code-fn">npm</span> run backend &   <span class="code-comment"># tinbase :54321 — prints anon +</span>
                    <span class="code-comment"># service_role keys (like supabase start)</span>
<span class="code-fn">npm</span> start           <span class="code-comment"># Metro dev server :8083</span>

<span class="code-comment"># App tab: the todo app. Studio tab: tinbase's dashboard</span>
<span class="code-comment"># at /_/ — paste the service_role key from the terminal</span>
<span class="code-comment"># to browse tables, run SQL and watch logs.</span>

<span class="code-comment"># .env — like a real Expo project (inlined by Metro):</span>
<span class="code-comment">#   EXPO_PUBLIC_SUPABASE_URL=/_sw/54321</span>
<span class="code-comment">#   EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...</span>

<span class="code-keyword">const</span> supabase = <span class="code-fn">createClient</span>(url, anonKey)
<span class="code-keyword">await</span> supabase.<span class="code-fn">from</span>(<span class="code-string">'todos'</span>).<span class="code-fn">insert</span>({ title })`;

export const codeSnippets: Record<string, string> = {
	interactive: CODE_INTERACTIVE,
	headless: CODE_HEADLESS,
	multi: CODE_MULTI,
	http: CODE_HTTP,
	explorer: CODE_EXPLORER,
	git: CODE_GIT,
	ffmpeg: CODE_FFMPEG,
	npm: CODE_NPM,
	cli: CODE_CLI,
	'lifo-pkg': CODE_LIFO_PKG,
	'build-pkg': CODE_BUILD_PKG,
	'vite-react': CODE_VITE_REACT,
	'vite-react-ts': CODE_VITE_REACT_TS,
	'create-vite': CODE_CREATE_VITE,
	tinbase: CODE_TINBASE,
	pglite: CODE_PGLITE,
	expo: CODE_EXPO,
	'expo-router': CODE_EXPO_ROUTER,
	'create-expo-app': CODE_CREATE_EXPO_APP,
	'expo-supabase': CODE_EXPO_SUPABASE,
};
