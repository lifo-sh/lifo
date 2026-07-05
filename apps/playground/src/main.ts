import './app.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal, FileExplorer } from '@lifo-sh/ui';
import type { EditorProvider, EditorInstance } from '@lifo-sh/ui';

declare global {
	interface Window {
		MonacoEnvironment?: {
			getWorker(workerId: string, label: string): Worker;
		};
	}
}
import {
	Sandbox,
	Kernel,
	Shell,
	createDefaultRegistry,
	bootLifoPackages,
	createPsCommand,
	createTopCommand,
	createKillCommand,
	createWatchCommand,
	createHelpCommand,
	createNodeCommand,
	createCurlCommand,
	createTunnelCommand,
	createTunnelCommandV2,
	createIfconfigCommand,
	createRouteCommand,
	createNetstatCommand,
	createHostCommand,
	createIPCommand,
	createNpmCommand,
	createNpxCommand,
	createLifoPkgCommand,
	createSystemctlCommand,
	createForwardCommand,
	createUnforwardCommand,
	createPortsCommand,
	createTestRegistryCommand,
	createNewtabCommand,
} from '@lifo-sh/core';
import gitCommand from 'lifo-pkg-git';
import ffmpegCommand from 'lifo-pkg-ffmpeg';

/// ─── Code snippets for each example ───

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
<span class="code-comment"># running entirely in your browser.</span>
<span class="code-comment"># Prereq on the host: node apps/tunnel-server/server.js</span>

<span class="code-fn">cd</span> react-app
<span class="code-fn">npm</span> install          <span class="code-comment"># real npm registry, in-browser</span>
<span class="code-fn">npm</span> run dev &        <span class="code-comment"># vite on virtual port 5173</span>

<span class="code-comment"># open http://localhost:3005 in a new browser tab, then:</span>
<span class="code-fn">sed</span> -i <span class="code-string">'s/React inside Lifo/Hello HMR/'</span> src/App.jsx

<span class="code-comment"># the page hot-updates via react-refresh —</span>
<span class="code-comment"># click the counter first and watch state survive</span>`;

const CODE_VITE_REACT_TS = `\
<span class="code-comment"># Vite + React + TypeScript, same stack as the JS</span>
<span class="code-comment"># example: tsx transforms, fast-refresh, tunnel serving.</span>
<span class="code-comment"># Prereq on the host: node apps/tunnel-server/server.js</span>

<span class="code-fn">cd</span> react-ts-app
<span class="code-fn">npm</span> install
<span class="code-fn">npm</span> run dev &

<span class="code-comment"># open http://localhost:3005 in a new browser tab, then:</span>
<span class="code-fn">sed</span> -i <span class="code-string">'s/React inside Lifo/Hello HMR/'</span> src/App.tsx`;

const CODE_CREATE_VITE = `\
<span class="code-comment"># Prove it's the real Vite: scaffold an untouched app</span>
<span class="code-comment"># with create-vite and run it 1:1 — its own vite.config.js,</span>
<span class="code-comment"># its own scripts, zero Lifo-specific changes.</span>
<span class="code-comment"># Prereq on the host: node apps/tunnel-server/server.js</span>

<span class="code-fn">npx</span> create-vite@7.1.3 my-app --template react
<span class="code-fn">cd</span> my-app
<span class="code-fn">npm</span> install
<span class="code-fn">npm</span> run dev &

<span class="code-comment"># open http://localhost:3005 — the scaffolded app served</span>
<span class="code-comment"># by unmodified Vite from inside your browser, HMR and</span>
<span class="code-comment"># all: the browser speaks real WebSocket frames to the</span>
<span class="code-comment"># ws server running inside the VM.</span>`;

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

const codeSnippets: Record<string, string> = {
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
	pglite: CODE_PGLITE,
};

// ─── State ───

type ExampleId = 'interactive' | 'headless' | 'multi' | 'http' | 'explorer' | 'git' | 'ffmpeg' | 'npm' | 'cli' | 'lifo-pkg' | 'build-pkg' | 'vite-react' | 'vite-react-ts' | 'create-vite' | 'pglite';

const examples: Record<ExampleId, { booted: boolean; boot: () => Promise<void> }> = {
	interactive: { booted: false, boot: bootInteractive },
	headless: { booted: false, boot: bootHeadless },
	multi: { booted: false, boot: bootMulti },
	http: { booted: false, boot: bootHttp },
	explorer: { booted: false, boot: bootExplorer },
	git: { booted: false, boot: bootGit },
	ffmpeg: { booted: false, boot: bootFfmpeg },
	npm: { booted: false, boot: bootNpm },
	cli: { booted: false, boot: bootCli },
	'lifo-pkg': { booted: false, boot: bootLifoPkg },
	'build-pkg': { booted: false, boot: bootBuildPkg },
	'vite-react': { booted: false, boot: bootViteReact },
	'vite-react-ts': { booted: false, boot: bootViteReactTs },
	'create-vite': { booted: false, boot: bootCreateVite },
	pglite: { booted: false, boot: bootPglite },
};

let activeExample: ExampleId = 'interactive';

// ─── Mobile toggle helpers ───

const sidebar = document.getElementById('sidebar')!;
const sidebarBackdrop = document.getElementById('sidebar-backdrop')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const colCode = document.getElementById('col-code')!;
const codeToggle = document.getElementById('code-toggle')!;

function openSidebar() {
	sidebar.classList.remove('-translate-x-full');
	sidebar.classList.add('translate-x-0');
	sidebarBackdrop.classList.remove('hidden');
}

function closeSidebar() {
	sidebar.classList.add('-translate-x-full');
	sidebar.classList.remove('translate-x-0');
	sidebarBackdrop.classList.add('hidden');
}

sidebarToggle.addEventListener('click', () => {
	const isOpen = sidebar.classList.contains('translate-x-0');
	if (isOpen) closeSidebar();
	else openSidebar();
});

sidebarBackdrop.addEventListener('click', closeSidebar);

codeToggle.addEventListener('click', () => {
	const isVisible = colCode.classList.contains('flex');
	if (isVisible) {
		colCode.classList.remove('flex');
		colCode.classList.add('hidden');
	} else {
		colCode.classList.remove('hidden');
		colCode.classList.add('flex');
	}
});

// ─── Navigation ───

const codeBlockEl = document.getElementById('code-block')!;

document.querySelectorAll<HTMLButtonElement>('.sidebar-item').forEach((btn) => {
	btn.addEventListener('click', () => {
		const id = btn.dataset.example as ExampleId;
		if (id === activeExample) return;
		switchExample(id);
	});
});

function switchExample(id: ExampleId) {
	// Sidebar
	document.querySelectorAll('.sidebar-item').forEach((el) => el.classList.remove('active'));
	document.querySelector(`[data-example="${id}"]`)?.classList.add('active');

	// Code column -- hide for examples that don't need it
	if (id === 'cli' || id === 'lifo-pkg' || id === 'build-pkg') {
		colCode.classList.remove('lg:flex');
		colCode.classList.add('lg:hidden');
	} else {
		colCode.classList.remove('lg:hidden');
		colCode.classList.add('lg:flex');
		codeBlockEl.innerHTML = codeSnippets[id];
	}

	// Output column
	document.querySelectorAll('.output-panel').forEach((el) => el.classList.remove('active'));
	document.getElementById(`out-${id}`)?.classList.add('active');

	activeExample = id;

	// Close sidebar on mobile after selecting
	closeSidebar();

	// Lazy-boot
	const ex = examples[id];
	if (!ex.booted) {
		ex.booted = true;
		ex.boot();
	}
}
// ─── 1. Interactive Shell (tabbed, persistent) ───

let interactiveKernel: Kernel | null = null;

interface InteractiveTab {
	id: number;
	tabBtn: HTMLButtonElement;
	panel: HTMLDivElement;
	terminal: Terminal;
	shell: Shell;
}

let interactiveTabs: InteractiveTab[] = [];
let interactiveActiveTabId = -1;
let interactiveNextId = 1;

async function bootInteractive() {
	interactiveKernel = new Kernel();
	await interactiveKernel.boot({ persist: true });

	// Expose kernel to Vite dev server for port bridging
	if (typeof (globalThis as any).__setLifoKernel === 'function') {
		(globalThis as any).__setLifoKernel(() => interactiveKernel);
	}

	// Initialize service manager for systemctl support
	const env = interactiveKernel.getDefaultEnv();
	const tempRegistry = createDefaultRegistry();
	tempRegistry.register('tunnel', createTunnelCommandV2(interactiveKernel));
	interactiveKernel.initServiceManager(tempRegistry, env);

	// Create tunnel systemd service unit
	interactiveKernel.vfs.mkdir('/etc/systemd/system', { recursive: true });
	interactiveKernel.vfs.writeFile('/etc/systemd/system/tunnel.service', `[Unit]
Description=WebSocket Tunnel Service
After=network.target

[Service]
Type=simple
ExecStart=tunnel --server ws://localhost:3005 --port 5173
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`);

	// Enable the tunnel service
	if (interactiveKernel.serviceManager) {
		interactiveKernel.serviceManager.enable('tunnel');
	}

	// Create sample Vite app for testing
	const vfs = interactiveKernel.vfs;
	vfs.mkdir('/home/user/vite-project', { recursive: true });
	vfs.writeFile('/home/user/vite-project/package.json', JSON.stringify({
		name: 'vite-project',
		version: '1.0.0',
		type: 'module',
		scripts: {
			dev: 'vite',
			build: 'vite build',
		},
		dependencies: {
			vite: '^7.3.1',
		},
	}, null, 2));

	vfs.writeFile('/home/user/vite-project/index.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vite App in Lifo</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>`);

	vfs.writeFile('/home/user/vite-project/main.js', `document.getElementById('app').innerHTML = \`
  <h1>Hello from Vite in Lifo! 🚀</h1>
  <p>This Vite dev server is running entirely in your browser!</p>
  <p>Port: <strong>5173</strong></p>
  <p>Try accessing from another tab with: <code>curl localhost:5173</code></p>
\`;

console.log('Vite app loaded successfully!');
`);

	// ── React example (react-app) — shared with the Vite with React sidebar example
	for (const [p, c] of Object.entries(viteReactAppFiles('/home/user/react-app', false))) {
		const dir = p.slice(0, p.lastIndexOf('/'));
		vfs.mkdir(dir, { recursive: true });
		vfs.writeFile(p, c);
	}

	// NOTE: We intentionally DO NOT create vite.config.js because esbuild-wasm
	// cannot handle config file loading in the VFS (directory traversal issues).
	// Users should either:
	// 1. Use vite-direct.js (which sets configFile: false)
	// 2. Use CLI flags: npx vite --port 5173 --host localhost

	// Create a simple test server to verify HTTP registration works
	vfs.writeFile('/home/user/vite-project/test-server.js', `// Simple HTTP server test
// This verifies that virtual HTTP servers work correctly

const http = require('http');

console.log('Creating HTTP server...');
console.log('NOTE: Server must stay running! Do NOT press Ctrl+C');
console.log('Open a NEW tab (+) to test with "ports" and "curl"');
console.log('');

const server = http.createServer((req, res) => {
  console.log(\`✅ Request received: \${req.method} \${req.url}\`);

  res.writeHead(200, {
    'Content-Type': 'text/html',
    'X-Powered-By': 'Lifo Virtual HTTP'
  });

  res.end(\`<!DOCTYPE html>
<html>
<head><title>Test Server</title></head>
<body>
  <h1>✅ HTTP Server Works!</h1>
  <p>Port: <strong>3000</strong></p>
  <p>This proves the virtual HTTP server is registered correctly.</p>
  <p>Try: <code>curl localhost:3000</code> from another tab</p>
  <p>Or visit: <a href="/api/proxy/3000/">/api/proxy/3000/</a></p>
</body>
</html>\`);
});

console.log('Starting server on port 3000...');

server.listen(3000, () => {
  console.log('');
  console.log('🎉 ===================================');
  console.log('🎉 Server is RUNNING on port 3000!');
  console.log('🎉 ===================================');
  console.log('');
  console.log('Test commands IN A NEW TAB (+):');
  console.log('  1. ports');
  console.log('  2. curl localhost:3000');
  console.log('');
  console.log('⚠️  IMPORTANT: Keep this tab running!');
  console.log('⚠️  Do NOT close or stop this process');
  console.log('');
});

server.on('error', (err) => {
  console.error('❌ Server error:', err.message);
});

// Keep the process alive
setInterval(() => {
  // Noop to prevent process exit
}, 60000);
`);

	// Create direct Vite runner that doesn't use npm
	vfs.writeFile('/home/user/vite-project/vite-direct.js', `#!/usr/bin/env node
// Direct Vite runner - runs Vite without npm spawning a child process
// This keeps the server process alive so ports stay registered

console.log('🚀 Starting Vite directly...');
console.log('');

// Import and run Vite's CLI directly
async function startVite() {
  try {
    // Dynamically import Vite
    const vite = await import('vite');

    console.log('📦 Vite imported successfully');
    console.log('⚙️  Creating dev server...');

    // Create Vite dev server
    const server = await vite.createServer({
      configFile: false, // Skip config file to avoid esbuild issues in VFS
      root: process.cwd(),
      server: {
        port: 5173,
        host: 'localhost',
      },
    });

    console.log('🎯 Starting server on port 5173...');
    await server.listen();

    const info = server.config.logger.info;
    info('');
    info('  ✅ Vite dev server is running!');
    info('');
    info('  Test in another tab:');
    info('    1. ports');
    info('    2. curl localhost:5173');
    info('');
    info('  ⚠️  Keep this tab open - do NOT stop the process!');
    info('');

    // Keep process alive - wait for server close
    await new Promise((resolve) => {
      server.httpServer?.on('close', resolve);
    });

  } catch (error) {
    console.error('❌ Error starting Vite:', error.message);
    console.error('');
    console.error('Vite may not be installed. Try:');
    console.error('  npm install vite');
    console.error('');
    console.error('Or use the test server instead:');
    console.error('  node test-server.js');
    process.exit(1);
  }
}

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err);
});

// Start Vite
startVite().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
`);

	vfs.writeFile('/home/user/vite-project/README.md', `# Vite Project in Lifo

⚠️ **IMPORTANT**: Use \`node vite-direct.js\` to run Vite (NOT \`npm run dev\`)

## Quick Start

### Step 1: Test Basic HTTP Server (START HERE!)
\`\`\`bash
cd vite-project
node test-server.js
\`\`\`

**Leave this running!** Open a NEW tab (+) and run:
\`\`\`bash
ports          # Should show port 3000
curl localhost:3000
\`\`\`

If this works, HTTP is working correctly! ✅

### Step 2: Run Vite Directly (Recommended)
\`\`\`bash
node vite-direct.js
\`\`\`

This runs Vite without a config file, avoiding esbuild issues in the VFS.

**Alternative methods:**
\`\`\`bash
# Using npm with CLI flags (also works)
npm run dev

# Manual with CLI flags
npx vite --port 5173 --host localhost
\`\`\`

### Step 3: Access the Server (in another tab)

\`\`\`bash
ports          # Should show port 5173
curl localhost:5173
\`\`\`

Or browser: http://localhost:3000/api/proxy/5173/

## Why node vite-direct.js?

1. **No config file loading**: Avoids esbuild-wasm directory traversal issues
2. **Process stays alive**: Runs Vite in the same process, keeping ports registered
3. **Better control**: Inline configuration, easier to debug

## Troubleshooting

### "No ports registered" after starting server
- The process exited and cleaned up the port
- Use \`node vite-direct.js\` instead of \`npm run dev\`
- Check console for \`[lifo-http] ❌ Server.close()\` messages

### Test if kernel is shared between tabs
\`\`\`bash
# Tab 1:
test-registry set

# Tab 2:
test-registry get    # Should show "Has port: true"
\`\`\`

## How It Works

1. **Virtual HTTP Server**: Uses node-compat's virtual HTTP implementation
2. **Port Registry**: Servers register in kernel.portRegistry[port]
3. **Process Lifetime**: Server must stay running to keep port registered
4. **Port Bridge**: Vite dev server plugin proxies to virtual ports

Enjoy your browser-native development server! 🚀
`);

	await addInteractiveTab();

	document.getElementById('interactive-add-tab')!.addEventListener('click', () => {
		addInteractiveTab();
	});
}

async function addInteractiveTab(): Promise<InteractiveTab> {
	const kernel = interactiveKernel!;
	const id = interactiveNextId++;

	const tabBar = document.getElementById('interactive-tab-bar')!;
	const addBtn = document.getElementById('interactive-add-tab')!;
	const tabBtn = document.createElement('button');
	tabBtn.className = 'tab-btn px-3.5 py-[5px] bg-transparent border-none text-tokyo-comment text-xs font-medium cursor-pointer rounded-t-[5px] transition-colors whitespace-nowrap hover:text-tokyo-muted hover:bg-tokyo-hover';
	tabBtn.textContent = `Terminal ${id}`;
	tabBtn.addEventListener('click', () => switchInteractiveTab(id));
	tabBar.insertBefore(tabBtn, addBtn);

	const panels = document.getElementById('interactive-tab-panels')!;
	const panel = document.createElement('div');
	panel.className = 'tab-panel';
	const container = document.createElement('div');
	container.className = 'w-full h-full';
	panel.appendChild(container);
	panels.appendChild(panel);

	const terminal = new Terminal(container);
	const registry = createDefaultRegistry();
	bootLifoPackages(kernel.vfs, registry);

	const env = kernel.getDefaultEnv();
	const shell = new Shell(terminal, kernel.vfs, registry, env, kernel.processRegistry);

	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));

	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));


	const httpNpmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, httpNpmShellExecute));
	registry.register('npx', createNpxCommand(registry, httpNpmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, httpNpmShellExecute));




	// Register node, curl, and tunnel with kernel
	registry.register('node', createNodeCommand(kernel));
	registry.register('curl', createCurlCommand(kernel));
	registry.register('tunnel', createTunnelCommandV2(kernel));


	// Register network commands
	registry.register('ifconfig', createIfconfigCommand(kernel));
	registry.register('route', createRouteCommand(kernel));
	registry.register('netstat', createNetstatCommand(kernel));
	registry.register('host', createHostCommand(kernel));
	registry.register('ip', createIPCommand(kernel));
	registry.register('forward', createForwardCommand(kernel));
	registry.register('unforward', createUnforwardCommand(kernel));
	registry.register('ports', createPortsCommand(kernel));
	registry.register('test-registry', createTestRegistryCommand(kernel));
	registry.register('newtab', createNewtabCommand());

	// Register systemctl command
	registry.register('systemctl', createSystemctlCommand(kernel));


	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));



	const interactiveNpmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, interactiveNpmShellExecute, interactiveKernel));
	registry.register('lifo', createLifoPkgCommand(registry, interactiveNpmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');
	await kernel.bootServices();
	shell.start();

	const tab: InteractiveTab = { id, tabBtn, panel, terminal, shell };
	interactiveTabs.push(tab);
	switchInteractiveTab(id);

	return tab;
}

function switchInteractiveTab(id: number) {
	if (id === interactiveActiveTabId) return;
	interactiveActiveTabId = id;

	for (const tab of interactiveTabs) {
		const isActive = tab.id === id;
		tab.tabBtn.classList.toggle('active', isActive);
		tab.panel.classList.toggle('active', isActive);
		if (isActive) tab.terminal.focus();
	}
}

// ─── 2. Headless / AI Agent ───


let headlessSandbox: Sandbox | null = null;

async function bootHeadless() {
	document.getElementById('headless-run')!.addEventListener('click', runHeadlessExample);
}

async function runHeadlessExample() {
	const outputEl = document.getElementById('headless-output')!;
	const runBtn = document.getElementById('headless-run') as HTMLButtonElement;

	runBtn.disabled = true;
	outputEl.textContent = 'Running...\n';
	headlessSandbox?.destroy();

	try {
		const log = (text: string) => { outputEl.textContent += text; };

		log('> Creating sandbox...\n');
		headlessSandbox = await Sandbox.create();
		log('  Sandbox ready. cwd = ' + headlessSandbox.cwd + '\n\n');

		log('> sandbox.commands.run(\'echo "Hello from Lifo!"\')\n');
		const r1 = await headlessSandbox.commands.run('echo "Hello from Lifo!"');
		log('  stdout: ' + JSON.stringify(r1.stdout) + '\n');
		log('  exitCode: ' + r1.exitCode + '\n\n');

		log('> sandbox.fs.writeFile(\'/home/user/app.js\', ...)\n');
		await headlessSandbox.fs.writeFile('/home/user/app.js', 'console.log("hi")');
		log('  Done.\n\n');

		log('> sandbox.fs.readFile(\'/home/user/app.js\')\n');
		const content = await headlessSandbox.fs.readFile('/home/user/app.js');
		log('  content: ' + JSON.stringify(content) + '\n\n');

		log('> sandbox.commands.run(\'export GREETING=world\')\n');
		await headlessSandbox.commands.run('export GREETING=world');
		log('  Done.\n\n');

		log('> sandbox.commands.run(\'echo $GREETING | cat\')\n');
		const r2 = await headlessSandbox.commands.run('echo $GREETING | cat');
		log('  stdout: ' + JSON.stringify(r2.stdout) + '\n\n');

		log('> sandbox.fs.readdir(\'/home/user\')\n');
		const entries = await headlessSandbox.fs.readdir('/home/user');
		for (const e of entries) {
			log('  ' + (e.type === 'directory' ? '/' : ' ') + e.name + '\n');
		}
		log('\n');

		log('> sandbox.destroy()\n');
		headlessSandbox.destroy();
		headlessSandbox = null;
		log('  Done. All resources released.\n');
	} catch (e) {
		outputEl.textContent += '\nError: ' + (e instanceof Error ? e.message : String(e)) + '\n';
	} finally {
		runBtn.disabled = false;
	}
}

// ─── 3. Multi Terminal (tabbed, shared kernel) ───

let multiKernel: Kernel | null = null;

interface MultiTab {
	id: number;
	tabBtn: HTMLButtonElement;
	panel: HTMLDivElement;
	terminal: Terminal;
	shell: Shell;
}

let multiTabs: MultiTab[] = [];
let multiActiveTabId = -1;
let multiNextId = 1;

async function bootMulti() {
	multiKernel = new Kernel();
	await multiKernel.boot({ persist: false });

	await addMultiTab();
	await addMultiTab();

	document.getElementById('multi-add-tab')!.addEventListener('click', () => {
		addMultiTab();
	});
}

async function addMultiTab(): Promise<MultiTab> {
	const kernel = multiKernel!;
	const id = multiNextId++;

	const tabBar = document.getElementById('multi-tab-bar')!;
	const addBtn = document.getElementById('multi-add-tab')!;
	const tabBtn = document.createElement('button');
	tabBtn.className = 'tab-btn px-3.5 py-[5px] bg-transparent border-none text-tokyo-comment text-xs font-medium cursor-pointer rounded-t-[5px] transition-colors whitespace-nowrap hover:text-tokyo-muted hover:bg-tokyo-hover';
	tabBtn.textContent = `Terminal ${id}`;
	tabBtn.addEventListener('click', () => switchMultiTab(id));
	tabBar.insertBefore(tabBtn, addBtn);

	const panels = document.getElementById('multi-tab-panels')!;
	const panel = document.createElement('div');
	panel.className = 'tab-panel';
	const container = document.createElement('div');
	container.className = 'w-full h-full';
	panel.appendChild(container);
	panels.appendChild(panel);

	const terminal = new Terminal(container);
	const registry = createDefaultRegistry();
	registry.register('git', gitCommand);
	bootLifoPackages(kernel.vfs, registry);

	const env = kernel.getDefaultEnv();
	const shell = new Shell(terminal, kernel.vfs, registry, env, kernel.processRegistry);

	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));

	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));

	const multiNpmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, multiNpmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, multiNpmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');
	shell.start();

	const tab: MultiTab = { id, tabBtn, panel, terminal, shell };
	multiTabs.push(tab);
	switchMultiTab(id);

	return tab;
}

function switchMultiTab(id: number) {
	if (id === multiActiveTabId) return;
	multiActiveTabId = id;

	for (const tab of multiTabs) {
		const isActive = tab.id === id;
		tab.tabBtn.classList.toggle('active', isActive);
		tab.panel.classList.toggle('active', isActive);
		if (isActive) tab.terminal.focus();
	}
}

// ─── 4. HTTP Server (tabbed, shared kernel with virtual ports) ───

let httpKernel: Kernel | null = null;

interface HttpTab {
	id: string;
	tabBtn: HTMLButtonElement;
	panel: HTMLDivElement;
	terminal: Terminal;
	shell: Shell;
}

let httpTabs: HttpTab[] = [];
let httpActiveTabId = '';

async function bootHttp() {
	httpKernel = new Kernel();
	await httpKernel.boot({ persist: false });

	// Expose kernel to Vite dev server for port bridging
	if (typeof (globalThis as any).__setLifoKernel === 'function') {
		(globalThis as any).__setLifoKernel(() => httpKernel);
	}

	// Initialize service manager for systemctl support
	const env = httpKernel.getDefaultEnv();
	const tempRegistry = createDefaultRegistry();
	// Register tunnel command so it's available for service execution
	tempRegistry.register('tunnel', createTunnelCommandV2(httpKernel));
	httpKernel.initServiceManager(tempRegistry, env);

	// Create tunnel systemd service unit
	httpKernel.vfs.mkdir('/etc/systemd/system', { recursive: true });
	httpKernel.vfs.writeFile('/etc/systemd/system/tunnel.service', `[Unit]
Description=WebSocket Tunnel Service
After=network.target

[Service]
Type=simple
ExecStart=tunnel --server ws://localhost:3005 --port 5173
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`);

	// Enable the tunnel service so it can be started with systemctl
	if (httpKernel.serviceManager) {
		httpKernel.serviceManager.enable('tunnel');
	}

	// Write server.js to VFS
	httpKernel.vfs.writeFile('/home/user/server.js', `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from Lifo 333!\\n');
});
server.listen(3000, () => {
  console.log('Server running on port 3000');
});
`);


	httpKernel.vfs.writeFile('/home/user/server2.js', `const http = require('http');

	// Proxy server that forwards all requests to port 3000
	const server = http.createServer((req, res) => {
		// Use synchronous internal API to forward to port 3000
		// This works because both servers are in the same virtual environment
		const proxyRes = http._syncRequest({
			hostname: 'localhost',
			port: 3000,
			path: req.url,
			method: req.method,
			headers: req.headers
		});

		if (proxyRes) {
			// Forward the response from port 3000
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			res.end(proxyRes.body);
			console.log(\`[Proxy] \${req.method} \${req.url} -> 3000 -> \${proxyRes.statusCode}\`);
		} else {
			// Port 3000 is not running
			res.writeHead(502, { 'Content-Type': 'text/plain' });
			res.end('Bad Gateway: Server on port 3000 is not running.\\n');
			console.error('[Proxy] Port 3000 is not available');
		}
	});

	server.listen(3004, () => {
		console.log('Proxy server running on port 3004 (forwarding to 3000)');
		console.log('All requests to 3001 will be tunneled to 3000');
	});
	`);

	httpKernel.vfs.writeFile('/home/user/server5173.js', `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from Lifo5173!\\n');
});
server.listen(5173, () => {
  console.log('Server running on port 5173');
});
`);

	await addHttpTab('Server');
	await addHttpTab('Client');
	await addHttpTab('Client2');
	await addHttpTab('Server 5173');
	await addHttpTab('New Tab');

	// Start the tunnel service automatically
	if (httpKernel.serviceManager) {
		try {
			await httpKernel.serviceManager.start('tunnel');
			console.log('Tunnel service started automatically');
		} catch (error) {
			console.error('Failed to start tunnel service:', error);
		}
	}
}

async function addHttpTab(label: string): Promise<HttpTab> {
	const kernel = httpKernel!;
	const id = label.toLowerCase();

	const tabBar = document.getElementById('http-tab-bar')!;
	const tabBtn = document.createElement('button');
	tabBtn.className = 'tab-btn px-3.5 py-[5px] bg-transparent border-none text-tokyo-comment text-xs font-medium cursor-pointer rounded-t-[5px] transition-colors whitespace-nowrap hover:text-tokyo-muted hover:bg-tokyo-hover';
	tabBtn.textContent = label;
	tabBtn.addEventListener('click', () => switchHttpTab(id));
	tabBar.appendChild(tabBtn);

	const panels = document.getElementById('http-tab-panels')!;
	const panel = document.createElement('div');
	panel.className = 'tab-panel';
	const container = document.createElement('div');
	container.className = 'w-full h-full';
	panel.appendChild(container);
	panels.appendChild(panel);

	const terminal = new Terminal(container);
	const registry = createDefaultRegistry();
	registry.register('git', gitCommand);
	bootLifoPackages(kernel.vfs, registry);

	// Register node, curl, and tunnel with kernel
	registry.register('node', createNodeCommand(kernel));
	registry.register('curl', createCurlCommand(kernel));
	registry.register('tunnel', createTunnelCommandV2(kernel));


	// Register network commands
	registry.register('ifconfig', createIfconfigCommand(kernel));
	registry.register('route', createRouteCommand(kernel));
	registry.register('netstat', createNetstatCommand(kernel));
	registry.register('host', createHostCommand(kernel));
	registry.register('ip', createIPCommand(kernel));
	registry.register('forward', createForwardCommand(kernel));
	registry.register('unforward', createUnforwardCommand(kernel));
	registry.register('ports', createPortsCommand(kernel));
	registry.register('newtab', createNewtabCommand());

	// Register systemctl command
	registry.register('systemctl', createSystemctlCommand(kernel));

	const env = kernel.getDefaultEnv();
	const shell = new Shell(terminal, kernel.vfs, registry, env, kernel.processRegistry);

	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));


	const httpNpmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, httpNpmShellExecute));
	registry.register('npx', createNpxCommand(registry, httpNpmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, httpNpmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');
	await kernel.bootServices();
	shell.start();

	const tab: HttpTab = { id, tabBtn, panel, terminal, shell };
	httpTabs.push(tab);
	switchHttpTab(id);

	return tab;
}

function switchHttpTab(id: string) {
	if (id === httpActiveTabId) return;
	httpActiveTabId = id;

	for (const tab of httpTabs) {
		const isActive = tab.id === id;
		tab.tabBtn.classList.toggle('active', isActive);
		tab.panel.classList.toggle('active', isActive);
		if (isActive) tab.terminal.focus();
	}
}

// Expose addHttpTab globally for adding tabs dynamically
(window as any).addHttpTab = (label?: string) => {
	const tabName = label || `Tab ${httpTabs.length + 1}`;
	return addHttpTab(tabName);
};

// ─── 5. File Explorer (split pane: explorer + terminal) ───

let explorerKernel: Kernel | null = null;

function createMonacoProvider(): EditorProvider {
	return {
		create(container: HTMLElement, content: string, language: string): EditorInstance {
			// Lazy-load Monaco
			let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null;
			let disposed = false;
			const changeCallbacks: (() => void)[] = [];

			import('monaco-editor').then((monaco) => {
				if (disposed) return;

				// Configure Monaco workers
				window.MonacoEnvironment = {
					getWorker(_workerId: string, label: string) {
						if (label === 'json') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						if (label === 'css' || label === 'scss' || label === 'less') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						if (label === 'html' || label === 'handlebars' || label === 'razor') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						if (label === 'typescript' || label === 'javascript') {
							return new Worker(
								new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
								{ type: 'module' },
							);
						}
						return new Worker(
							new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
							{ type: 'module' },
						);
					},
				};

				// Define Tokyo Night theme
				monaco.editor.defineTheme('tokyo-night', {
					base: 'vs-dark',
					inherit: true,
					rules: [
						{ token: 'comment', foreground: '565f89', fontStyle: 'italic' },
						{ token: 'keyword', foreground: 'bb9af7' },
						{ token: 'string', foreground: '9ece6a' },
						{ token: 'number', foreground: 'ff9e64' },
						{ token: 'type', foreground: '2ac3de' },
						{ token: 'identifier', foreground: 'c0caf5' },
						{ token: 'delimiter', foreground: '89ddff' },
					],
					colors: {
						'editor.background': '#1a1b26',
						'editor.foreground': '#a9b1d6',
						'editor.selectionBackground': '#33467c',
						'editor.lineHighlightBackground': '#1e2030',
						'editorCursor.foreground': '#c0caf5',
						'editorLineNumber.foreground': '#3b4261',
						'editorLineNumber.activeForeground': '#737aa2',
					},
				});

				editor = monaco.editor.create(container, {
					value: content,
					language,
					theme: 'tokyo-night',
					fontSize: 13,
					fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace',
					lineHeight: 20,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					automaticLayout: true,
					padding: { top: 8, bottom: 8 },
					renderLineHighlight: 'line',
					overviewRulerLanes: 0,
					hideCursorInOverviewRuler: true,
					overviewRulerBorder: false,
					scrollbar: {
						verticalScrollbarSize: 6,
						horizontalScrollbarSize: 6,
					},
				});

				editor.onDidChangeModelContent(() => {
					for (const cb of changeCallbacks) cb();
				});
			});

			return {
				getValue(): string {
					return editor?.getValue() ?? content;
				},
				onDidChangeContent(callback: () => void): void {
					changeCallbacks.push(callback);
				},
				dispose(): void {
					disposed = true;
					editor?.dispose();
					editor = null;
				},
			};
		},
	};
}

async function bootExplorer() {
	explorerKernel = new Kernel();
	await explorerKernel.boot({ persist: false });

	// Create some sample files so the explorer isn't empty
	const vfs = explorerKernel.vfs;
	vfs.mkdir('/home/user/projects', { recursive: true });
	vfs.mkdir('/home/user/projects/my-app/src', { recursive: true });
	vfs.writeFile('/home/user/projects/my-app/package.json', JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2));
	vfs.writeFile('/home/user/projects/my-app/src/index.ts', 'console.log("Hello from my-app!");\n');
	vfs.writeFile('/home/user/projects/my-app/src/utils.ts', 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
	vfs.writeFile('/home/user/projects/my-app/README.md', '# My App\n\nA sample project.\n');
	vfs.mkdir('/home/user/notes');
	vfs.writeFile('/home/user/notes/todo.txt', '- Try the file explorer\n- Edit some files\n- Create new folders\n');
	vfs.writeFile('/home/user/hello.sh', '#!/bin/sh\necho "Hello, world!"\n');

	// Mount file explorer with Monaco editor
	const explorerContainer = document.getElementById('explorer-panel')!;
	new FileExplorer(explorerContainer, vfs, {
		cwd: '/home/user',
		editorProvider: createMonacoProvider(),
	});

	// Mount terminal sharing the same kernel
	const termContainer = document.getElementById('explorer-terminal')!;
	const terminal = new Terminal(termContainer);
	const registry = createDefaultRegistry();
	registry.register('git', gitCommand);
	bootLifoPackages(vfs, registry);

	const env = explorerKernel.getDefaultEnv();
	const shell = new Shell(terminal, vfs, registry, env, explorerKernel.processRegistry);

	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));

	const explorerNpmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, explorerNpmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, explorerNpmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');
	shell.start();
}

// ─── 6. Git (via lifo-pkg-git) ───

async function bootGit() {
	const kernel = new Kernel();
	await kernel.boot({ persist: false });

	const container = document.getElementById('terminal-git')!;
	const terminal = new Terminal(container);

	const registry = createDefaultRegistry();
	registry.register('git', gitCommand);      // register from lifo-pkg-git
	registry.register('ffmpeg', ffmpegCommand); // register from lifo-pkg-ffmpeg
	bootLifoPackages(kernel.vfs, registry);

	const env = kernel.getDefaultEnv();
	const shell = new Shell(terminal, kernel.vfs, registry, env, kernel.processRegistry);

	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));

	// Register npm + lifo commands
	const npmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, npmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, npmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');
	shell.start();
}

// ─── 7. FFmpeg ───

let ffmpegKernel: Kernel | null = null;

async function bootFfmpeg() {
	ffmpegKernel = new Kernel();
	await ffmpegKernel.boot({ persist: false });

	const vfs = ffmpegKernel.vfs;

	// Create media directory and load sample video
	vfs.mkdir('/home/user/media', { recursive: true });

	try {
		const resp = await fetch('/sample.mp4');
		if (resp.ok) {
			const buf = await resp.arrayBuffer();
			vfs.writeFile('/home/user/media/sample.mp4', new Uint8Array(buf));
		}
	} catch {
		// Sample not available, user can upload via explorer
	}

	// Mount file explorer
	const explorerContainer = document.getElementById('ffmpeg-explorer-panel')!;
	new FileExplorer(explorerContainer, vfs, {
		cwd: '/home/user/media',
		editorProvider: createMonacoProvider(),
	});

	// Mount terminal sharing same kernel
	const termContainer = document.getElementById('ffmpeg-terminal')!;
	const terminal = new Terminal(termContainer);
	const registry = createDefaultRegistry();
	registry.register('git', gitCommand);
	registry.register('ffmpeg', ffmpegCommand);
	bootLifoPackages(vfs, registry);

	const env = ffmpegKernel.getDefaultEnv();
	const shell = new Shell(terminal, vfs, registry, env, ffmpegKernel.processRegistry);

	const jobTable = shell.getJobTable();
	const processRegistry = shell.getProcessRegistry();
	registry.register('ps', createPsCommand(processRegistry));
	registry.register('top', createTopCommand(processRegistry));
	registry.register('kill', createKillCommand(processRegistry));
	registry.register('watch', createWatchCommand(registry));
	registry.register('help', createHelpCommand(registry));

	const ffmpegNpmShellExecute = async (cmd: string, cmdCtx: { cwd: string; env: Record<string, string>; stdout: { write: (s: string) => void }; stderr: { write: (s: string) => void } }) => {
		const result = await shell.execute(cmd, {
			cwd: cmdCtx.cwd,
			env: cmdCtx.env,
			onStdout: (data: string) => cmdCtx.stdout.write(data),
			onStderr: (data: string) => cmdCtx.stderr.write(data),
		});
		return result.exitCode;
	};
	registry.register('npm', createNpmCommand(registry, ffmpegNpmShellExecute));
	registry.register('lifo', createLifoPkgCommand(registry, ffmpegNpmShellExecute));

	await shell.sourceFile('/etc/profile');
	await shell.sourceFile(env.HOME + '/.bashrc');
	shell.start();
}

// ─── 8. npm ───

async function bootNpm() {
	const terminal = new Terminal(document.getElementById('terminal-npm')!);
	await Sandbox.create({
		terminal,
	});
}

// ─── 8. CLI (Node.js) ───

async function bootCli() {
	const outputEl = document.getElementById('cli-output')!;

	outputEl.innerHTML = `\
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
}

// ─── 9. Lifo Package Manager (docs) ───

async function bootLifoPkg() {
	const el = document.getElementById('lifo-pkg-output')!;
	el.innerHTML = `\
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
}

// ─── 10. Build Lifo Packages (docs) ───

async function bootBuildPkg() {
	const el = document.getElementById('build-pkg-output')!;
	el.innerHTML = `\
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
}

// ─── Vite / React / PGlite project examples ───

const TUNNEL_SERVICE_UNIT = `[Unit]
Description=WebSocket Tunnel Service
After=network.target

[Service]
Type=simple
ExecStart=tunnel --server ws://localhost:3005 --port 5173
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

// No custom dev server and no Lifo-specific plugins anywhere: HMR flows
// through the real WebSocket pipe (relay ⟷ tunnel ⟷ in-VM ws server), so
// the seeded apps are exactly what a stock Vite setup looks like.
function viteReactAppFiles(root: string, ts: boolean): Record<string, string> {
	const x = ts ? 'tsx' : 'jsx';
	const files: Record<string, string> = {};

	files[`${root}/package.json`] = JSON.stringify({
		name: root.split('/').pop(),
		version: '1.0.0',
		type: 'module',
		scripts: { dev: 'vite', build: 'vite build' },
		dependencies: {
			react: '^18.3.1',
			'react-dom': '^18.3.1',
			vite: '^7.3.1',
			'@vitejs/plugin-react': '^5.0.0',
			...(ts ? { typescript: '~5.9.3', '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1' } : {}),
		},
	}, null, 2);

	// Stock Vite config — identical in shape to what create-vite scaffolds.
	files[`${root}/vite.config.js`] = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
`;

	files[`${root}/index.html`] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React in Lifo</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.${x}"></script>
</body>
</html>`;

	files[`${root}/src/main.${x}`] = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.${x}';

createRoot(document.getElementById('root')${ts ? '!' : ''}).render(<App />);
`;

	files[`${root}/src/App.${x}`] = `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState${ts ? '<number>' : ''}(0);
  return (
    <div style={{ fontFamily: 'system-ui', textAlign: 'center', marginTop: '4rem' }}>
      <h1>React inside Lifo 🚀</h1>
      <p>This React app is served by a Vite dev server running in your browser${ts ? ' — in TypeScript' : ''}.</p>
      <button onClick={() => setCount(count + 1)} style={{ padding: '0.6em 1.2em', fontSize: '1em' }}>
        count is {count}
      </button>
    </div>
  );
}
`;

	if (ts) {
		files[`${root}/tsconfig.json`] = JSON.stringify({
			compilerOptions: {
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'bundler',
				jsx: 'react-jsx',
				strict: true,
				noEmit: true,
				lib: ['ES2022', 'DOM', 'DOM.Iterable'],
			},
			include: ['src'],
		}, null, 2);
	}

	return files;
}

function pgliteFiles(root: string): Record<string, string> {
	return {
		[`${root}/package.json`]: JSON.stringify({
			name: 'pg-demo',
			version: '1.0.0',
			type: 'module',
			dependencies: { '@electric-sql/pglite': '^0.5.4' },
		}, null, 2),
		[`${root}/test.mjs`]: `import { PGlite } from '@electric-sql/pglite';

const db = new PGlite(); // in-memory postgres (wasm)
console.log('booting postgres...');

await db.exec(\`CREATE TABLE docs (id serial primary key, owner text NOT NULL, body text NOT NULL);\`);
await db.exec(\`INSERT INTO docs (owner, body) VALUES ('alice', 'alice doc 1'), ('alice', 'alice doc 2'), ('bob', 'bob doc');\`);
const all = await db.query('SELECT count(*)::int AS n FROM docs');
console.log('total rows:', all.rows[0].n);

// Row Level Security
await db.exec(\`
  CREATE ROLE alice LOGIN;
  GRANT SELECT ON docs TO alice;
  ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_docs ON docs FOR SELECT USING (owner = current_user);
\`);
await db.exec('SET ROLE alice');
const mine = await db.query('SELECT body FROM docs ORDER BY id');
console.log('alice sees:', JSON.stringify(mine.rows));
await db.exec('RESET ROLE');

const ver = await db.query('SELECT version()');
console.log('version:', ver.rows[0].version);
const j = await db.query(\`SELECT jsonb_build_object('ok', true) AS j\`);
console.log('jsonb:', JSON.stringify(j.rows[0].j));
console.log('ALL TESTS PASSED ✅');
`,
	};
}

async function bootProjectExample(id: string, files: Record<string, string>, cwd: string, withTunnel: boolean): Promise<void> {
	const sandbox = await Sandbox.create({
		terminal: document.getElementById(`terminal-${id}`) as HTMLElement,
		files: {
			...files,
			...(withTunnel ? { '/etc/systemd/system/tunnel.service': TUNNEL_SERVICE_UNIT } : {}),
		},
		cwd,
	});
	if (withTunnel && sandbox.kernel.serviceManager) {
		sandbox.kernel.serviceManager.enable('tunnel');
		try {
			await sandbox.kernel.serviceManager.start('tunnel');
		} catch (error) {
			console.warn(`[${id}] tunnel service failed to start (is the relay running on :3005?)`, error);
		}
	}
}

async function bootViteReact() {
	await bootProjectExample('vite-react', viteReactAppFiles('/home/user/react-app', false), '/home/user/react-app', true);
}

async function bootViteReactTs() {
	await bootProjectExample('vite-react-ts', viteReactAppFiles('/home/user/react-ts-app', true), '/home/user/react-ts-app', true);
}

async function bootCreateVite() {
	await bootProjectExample('create-vite', {}, '/home/user', true);
}

async function bootPglite() {
	await bootProjectExample('pglite', pgliteFiles('/home/user/pg-demo'), '/home/user/pg-demo', false);
}

// ─── Boot ───

// Show initial code
codeBlockEl.innerHTML = CODE_INTERACTIVE;

// Boot first example
examples.interactive.booted = true;
bootInteractive();
