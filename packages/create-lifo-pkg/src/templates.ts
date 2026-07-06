/**
 * Template generation for lifo packages.
 *
 * Generates a complete project with:
 *   - Package source (src/index.ts)
 *   - Build config (vite.config.ts, tsconfig)
 *   - Example Vite app for browser testing
 *   - CLI entry point for terminal testing
 */

export interface TemplateOptions {
  /** Short name, e.g. "hello" */
  name: string;
  /** Full npm name, e.g. "lifo-pkg-hello" */
  npmName: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export function generateTemplates(opts: TemplateOptions): GeneratedFile[] {
  const { name, npmName } = opts;
  const files: GeneratedFile[] = [];

  // ─── Root package.json ───
  files.push({
    path: 'package.json',
    content: JSON.stringify({
      name: npmName,
      version: '0.1.0',
      description: `${name} command for Lifo`,
      license: 'MIT',
      type: 'module',
      main: 'dist/index.js',
      module: 'dist/index.js',
      types: 'dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
      files: ['dist'],
      publishConfig: { access: 'public' },
      lifo: {
        commands: {
          [name]: './dist/index.js',
        },
      },
      keywords: ['lifo-pkg', name],
      scripts: {
        build: 'vite build',
        dev: 'vite build --watch',
        'test:browser': 'cd example && npm run dev',
        'test:cli': 'node test-cli.js',
      },
      peerDependencies: {
        '@lifo-sh/core': '*',
      },
      peerDependenciesMeta: {
        '@lifo-sh/core': { optional: true },
      },
      devDependencies: {
        '@lifo-sh/core': '^0.4.1',
        typescript: '^5.7.0',
        vite: '^6.0.0',
        'vite-plugin-dts': '^4.5.0',
      },
    }, null, 2) + '\n',
  });

  // ─── tsconfig.json ───
  files.push({
    path: 'tsconfig.json',
    content: JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        declaration: true,
        declarationMap: true,
        outDir: 'dist',
        rootDir: 'src',
        lib: ['ES2022', 'DOM'],
      },
      include: ['src'],
    }, null, 2) + '\n',
  });

  // ─── tsconfig.build.json ───
  files.push({
    path: 'tsconfig.build.json',
    content: JSON.stringify({
      extends: './tsconfig.json',
      exclude: ['tests'],
    }, null, 2) + '\n',
  });

  // ─── vite.config.ts ───
  files.push({
    path: 'vite.config.ts',
    content: `import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.build.json' }),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        '@lifo-sh/core',
      ],
    },
  },
});
`,
  });

  // ─── src/index.ts ───
  files.push({
    path: 'src/index.ts',
    content: `import type { Command, CommandContext } from '@lifo-sh/core';

const ${camelCase(name)}Command: Command = async (ctx: CommandContext): Promise<number> => {
  const args = ctx.args;

  if (args.includes('--help') || args.includes('-h')) {
    ctx.stdout.write('Usage: ${name} [options]\\n');
    ctx.stdout.write('\\nA lifo package command.\\n');
    return 0;
  }

  ctx.stdout.write('Hello from ${name}!\\n');
  return 0;
};

export default ${camelCase(name)}Command;
`,
  });

  // ─── example/package.json (Vite test app) ───
  files.push({
    path: 'example/package.json',
    content: JSON.stringify({
      name: `${npmName}-example`,
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
      },
      dependencies: {
        '@lifo-sh/core': '^0.4.1',
        '@lifo-sh/ui': '^0.4.1',
        [npmName]: 'file:..',
        '@xterm/xterm': '^5.5.0',
      },
      devDependencies: {
        vite: '^6.0.0',
      },
    }, null, 2) + '\n',
  });

  // ─── example/index.html ───
  files.push({
    path: 'example/index.html',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${npmName} - test</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1b26; color: #a9b1d6; font-family: system-ui; }
    #terminal { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
`,
  });

  // ─── example/main.ts ───
  files.push({
    path: 'example/main.ts',
    content: `import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@lifo-sh/ui';
import {
  Kernel,
  Shell,
  createDefaultRegistry,
  createHelpCommand,
  createLifoPkgCommand,
} from '@lifo-sh/core';
import ${camelCase(name)}Command from '${npmName}';

async function main() {
  // 1. Boot kernel
  const kernel = new Kernel();
  await kernel.boot();

  // 2. Set up commands
  const registry = createDefaultRegistry();
  registry.register('${name}', ${camelCase(name)}Command);
  registry.register('help', createHelpCommand(registry));
  registry.register('lifo', createLifoPkgCommand(registry));

  // 3. Create terminal + shell
  const terminal = new Terminal(document.getElementById('terminal')!);
  const shell = new Shell(terminal, kernel.vfs, registry, kernel.getDefaultEnv());

  await shell.sourceFile('/etc/profile');
  shell.start();
}

main();
`,
  });

  // ─── example/vite.config.ts ───
  files.push({
    path: 'example/vite.config.ts',
    content: `import { defineConfig } from 'vite';

export default defineConfig({
  // Resolve the local package
  resolve: {
    alias: {
      '${npmName}': new URL('../dist/index.js', import.meta.url).pathname,
    },
  },
});
`,
  });

  // ─── test-cli.js (CLI test entry point) ───
  files.push({
    path: 'test-cli.js',
    content: `#!/usr/bin/env node

/**
 * CLI test harness for ${npmName}.
 *
 * Usage:
 *   node test-cli.js
 *
 * Boots an interactive Lifo shell with the ${name} command
 * pre-registered so you can test it in a real terminal.
 */

import {
  Kernel,
  Shell,
  createDefaultRegistry,
  createHelpCommand,
  createLifoPkgCommand,
} from '@lifo-sh/core';
import ${camelCase(name)}Command from './dist/index.js';

/**
 * Minimal ITerminal backed by Node.js stdin/stdout.
 */
class NodeTerminal {
  #callbacks = [];

  constructor() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (data) => {
      for (const ch of data) {
        for (const cb of this.#callbacks) cb(ch);
      }
    });
  }

  write(data) { process.stdout.write(data); }
  writeln(data) { process.stdout.write(data + '\\r\\n'); }
  onData(cb) { this.#callbacks.push(cb); }
  get cols() { return process.stdout.columns || 80; }
  get rows() { return process.stdout.rows || 24; }
  focus() {}
  clear() { process.stdout.write('\\x1b[2J\\x1b[H'); }
  destroy() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function main() {
  const terminal = new NodeTerminal();

  // Boot kernel
  const kernel = new Kernel();
  await kernel.boot({ persist: false });

  // Set up commands
  const registry = createDefaultRegistry();
  registry.register('${name}', ${camelCase(name)}Command);
  registry.register('help', createHelpCommand(registry));
  registry.register('lifo', createLifoPkgCommand(registry));

  // Create shell
  const env = kernel.getDefaultEnv();
  const shell = new Shell(terminal, kernel.vfs, registry, env);

  // Override exit to terminate the process
  shell.builtins.set('exit', async () => {
    terminal.write('logout\\r\\n');
    terminal.destroy();
    process.exit(0);
  });

  await shell.sourceFile('/etc/profile');

  terminal.write('\\x1b[2m${npmName} test shell\\x1b[0m\\r\\n');
  terminal.write('\\x1b[2mType "${name}" to test your command, "exit" to quit.\\x1b[0m\\r\\n');

  shell.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
  });

  // ─── .gitignore ───
  files.push({
    path: '.gitignore',
    content: `node_modules
dist
example/node_modules
`,
  });

  // ─── README.md ───
  files.push({
    path: 'README.md',
    content: `# ${npmName}

A [Lifo](https://github.com/lifo-sh/lifo) package providing the \`${name}\` command.

## Install

\`\`\`bash
# Inside Lifo
lifo install ${name}

# Then use it
${name} --help
\`\`\`

## Development

\`\`\`bash
# Install dependencies
npm install

# Build the package
npm run build

# Test in browser (opens Vite dev server with a terminal)
npm run test:browser

# Test via CLI
npm run test:cli -- --help

# Watch mode (rebuild on changes)
npm run dev
\`\`\`

### Dev-link inside Lifo

If you're running Lifo in the browser, you can link this package for live development:

\`\`\`bash
lifo link ./path/to/${name}
${name} --help
lifo unlink ${npmName}
\`\`\`

## Publishing

\`\`\`bash
npm publish
\`\`\`

Once published, users install with \`lifo install ${name}\`.
`,
  });

  return files;
}

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
