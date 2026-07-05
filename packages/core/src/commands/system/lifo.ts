/**
 * lifo -- lifo package manager command.
 *
 * Subcommands:
 *   install|add <name>   install a lifo-pkg-* package (sugar over npm -g)
 *   remove  <name>       remove a lifo package
 *   list                 list installed lifo packages + dev links
 *   search  <term>       search npm for lifo-pkg-* packages
 *   init    <name>       scaffold a new lifo package template
 *   link    <path>       dev-link a local package directory
 *   unlink  <name>       remove a dev link
 */

import type { Command, CommandContext, CommandOutputStream } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { VFS } from '../../kernel/vfs/index.js';
import type { ShellExecuteFn } from './npm.js';
import { npmInstallGlobal, getBinEntries, registerBinCommand } from './npm.js';
import { resolve, join } from '../../utils/path.js';
import {
  linkPackage,
  unlinkPackage,
  readDevLinks,
  loadDevLinks,
} from '../../pkg/lifo-dev.js';
import {
  readLifoManifest,
  createLifoCommand,
} from '../../pkg/lifo-runtime.js';

const GLOBAL_MODULES = '/usr/lib/node_modules';

// ─── Helpers ───

function printHelp(stdout: CommandOutputStream): void {
  stdout.write('Usage: lifo <command> [args]\n\n');
  stdout.write('Commands:\n');
  stdout.write('  install|add <name>     install lifo-pkg-<name> from npm\n');
  stdout.write('  remove <name>          remove a lifo package\n');
  stdout.write('  list                   list lifo packages & dev links\n');
  stdout.write('  search <term>          search npm for lifo-pkg-* packages\n');
  stdout.write('  init <name>            scaffold a new lifo package\n');
  stdout.write('  link [path]            dev-link a local package\n');
  stdout.write('  unlink <name>          remove a dev link\n');
  stdout.write('\nEnvironment:\n');
  stdout.write('  LIFO_CDN               CDN for ESM imports (default: https://esm.sh)\n');
}

// ─── install ───

async function lifoInstall(
  ctx: CommandContext,
  registry: CommandRegistry,
): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr.write('lifo install: package name required\n');
    return 1;
  }

  // Resolve: if user types "ffmpeg", install "lifo-pkg-ffmpeg"
  const npmName = name.startsWith('lifo-pkg-') ? name : `lifo-pkg-${name}`;

  ctx.stdout.write(`Installing ${npmName} globally...\n`);

  // Install directly (no shell.execute round-trip)
  const exitCode = await npmInstallGlobal(npmName, ctx, registry);
  if (exitCode !== 0) return exitCode;

  // After npm install, check for lifo manifest and re-register with lifo runtime
  const pkgDir = join(GLOBAL_MODULES, npmName);
  const manifest = readLifoManifest(ctx.vfs, pkgDir);

  if (manifest) {
    for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
      const entryPath = join(pkgDir, entryRelPath);
      if (ctx.vfs.exists(entryPath)) {
        registry.register(cmdName, createLifoCommand(entryPath, ctx.vfs));
        ctx.stdout.write(`  registered command: ${cmdName}\n`);
      }
    }
  } else {
    ctx.stdout.write(`  (no lifo manifest found -- installed as plain npm package)\n`);
  }

  return 0;
}

// ─── remove ───

async function lifoRemove(
  ctx: CommandContext,
  registry: CommandRegistry,
): Promise<number> {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr.write('lifo remove: package name required\n');
    return 1;
  }

  const npmName = name.startsWith('lifo-pkg-') ? name : `lifo-pkg-${name}`;
  const pkgDir = join(GLOBAL_MODULES, npmName);

  if (!ctx.vfs.exists(pkgDir)) {
    ctx.stderr.write(`lifo: ${npmName} is not installed\n`);
    return 1;
  }

  // Unregister commands from manifest before removing
  const manifest = readLifoManifest(ctx.vfs, pkgDir);
  if (manifest) {
    for (const cmdName of Object.keys(manifest.commands)) {
      registry.unregister(cmdName);
    }
  }

  try {
    ctx.vfs.rmdirRecursive(pkgDir);
  } catch (e) {
    ctx.stderr.write(`lifo: could not remove ${npmName}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  ctx.stdout.write(`removed ${npmName}\n`);
  return 0;
}

// ─── list ───

function lifoList(ctx: CommandContext): number {
  const { vfs, stdout } = ctx;

  // 1. Installed lifo packages (global node_modules with lifo field)
  const installed: { name: string; version: string; commands: string[] }[] = [];

  if (vfs.exists(GLOBAL_MODULES)) {
    for (const entry of vfs.readdir(GLOBAL_MODULES)) {
      if (entry.type !== 'directory') continue;

      const dirs = entry.name.startsWith('@')
        ? (() => {
            try {
              return vfs.readdir(join(GLOBAL_MODULES, entry.name))
                .filter(e => e.type === 'directory')
                .map(e => join(entry.name, e.name));
            } catch { return []; }
          })()
        : [entry.name];

      for (const dirName of dirs) {
        const pkgDir = join(GLOBAL_MODULES, dirName);
        const manifest = readLifoManifest(vfs, pkgDir);
        if (!manifest) continue;

        let version = '?';
        try {
          const pkg = JSON.parse(vfs.readFileString(join(pkgDir, 'package.json')));
          version = pkg.version || '?';
        } catch { /* ignore */ }

        installed.push({
          name: dirName,
          version,
          commands: Object.keys(manifest.commands),
        });
      }
    }
  }

  // 2. Dev-linked packages
  const devLinks = readDevLinks(vfs);
  const devEntries = Object.entries(devLinks);

  if (installed.length === 0 && devEntries.length === 0) {
    stdout.write('No lifo packages installed\n');
    return 0;
  }

  if (installed.length > 0) {
    stdout.write('Installed:\n');
    for (const pkg of installed) {
      stdout.write(`  ${pkg.name}@${pkg.version}  [${pkg.commands.join(', ')}]\n`);
    }
  }

  if (devEntries.length > 0) {
    if (installed.length > 0) stdout.write('\n');
    stdout.write('Dev-linked:\n');
    for (const [name, link] of devEntries) {
      const cmds = Object.keys(link.commands).join(', ');
      stdout.write(`  ${name}  ${link.path}  [${cmds}]\n`);
    }
  }

  return 0;
}

// ─── search ───

async function lifoSearch(ctx: CommandContext): Promise<number> {
  const term = ctx.args.slice(1).join(' ');
  if (!term) {
    ctx.stderr.write('Usage: lifo search <term>\n');
    return 1;
  }

  const registry = ctx.env.NPM_REGISTRY || 'https://registry.npmjs.org';
  const query = `lifo-pkg-${term}`;
  const url = `${registry}/-/v1/search?text=${encodeURIComponent(query)}&size=20`;

  try {
    const response = await fetch(url, { signal: ctx.signal });
    if (!response.ok) throw new Error(`Registry returned ${response.status}`);

    const data = await response.json();
    const results = (data.objects as Array<{
      package: { name: string; version: string; description?: string };
    }>) || [];

    // Filter to only lifo-pkg-* packages
    const lifoResults = results.filter(r => r.package.name.startsWith('lifo-pkg-'));

    if (lifoResults.length === 0) {
      ctx.stdout.write('No lifo packages found\n');
      return 0;
    }

    ctx.stdout.write('NAME'.padEnd(30) + 'VERSION'.padEnd(12) + 'DESCRIPTION\n');
    ctx.stdout.write('-'.repeat(70) + '\n');

    for (const r of lifoResults) {
      const p = r.package;
      const displayName = p.name.replace(/^lifo-pkg-/, '');
      const name = displayName.length > 28 ? displayName.slice(0, 28) + '..' : displayName;
      const desc = (p.description || '').slice(0, 40);
      ctx.stdout.write(`${name.padEnd(30)}${p.version.padEnd(12)}${desc}\n`);
    }
  } catch (e) {
    ctx.stderr.write(`lifo search: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  return 0;
}

// ─── init ───

function lifoInit(ctx: CommandContext): number {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr.write('Usage: lifo init <name>\n');
    return 1;
  }

  const pkgDir = resolve(ctx.cwd, name);
  const npmName = name.startsWith('lifo-pkg-') ? name : `lifo-pkg-${name}`;
  const cmdName = name.replace(/^lifo-pkg-/, '');

  // Check if directory already exists
  if (ctx.vfs.exists(pkgDir)) {
    ctx.stderr.write(`lifo init: ${pkgDir} already exists\n`);
    return 1;
  }

  // Create directory structure
  ctx.vfs.mkdir(pkgDir, { recursive: true });
  ctx.vfs.mkdir(join(pkgDir, 'commands'), { recursive: true });

  // package.json
  const packageJson = {
    name: npmName,
    version: '0.1.0',
    description: `${cmdName} command for Lifo`,
    lifo: {
      commands: {
        [cmdName]: `./commands/${cmdName}.js`,
      },
    },
    keywords: ['lifo-pkg', cmdName],
    license: 'MIT',
  };
  ctx.vfs.writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n',
  );

  // Command entry template
  const commandTemplate = `/**
 * ${cmdName} -- lifo command
 *
 * This function receives:
 *   ctx  - CommandContext { args, env, cwd, vfs, stdout, stderr, signal, stdin }
 *   lifo - LifoAPI { import(), loadWasm(), resolve(), cdn }
 */
module.exports = async function(ctx, lifo) {
  const args = ctx.args;

  if (args.includes('--help') || args.includes('-h')) {
    ctx.stdout.write('Usage: ${cmdName} [options]\\n');
    ctx.stdout.write('\\nA lifo package command.\\n');
    return 0;
  }

  // Example: import an ESM module from CDN
  // const { default: lib } = await lifo.import('some-npm-package');

  // Example: load a WASM module
  // const wasmModule = await lifo.loadWasm('https://example.com/module.wasm');
  // const instance = await WebAssembly.instantiate(wasmModule);

  // Example: read/write files via VFS
  // const data = ctx.vfs.readFile(lifo.resolve('input.txt'));
  // ctx.vfs.writeFile(lifo.resolve('output.txt'), result);

  ctx.stdout.write('Hello from ${cmdName}!\\n');
  return 0;
};
`;
  ctx.vfs.writeFile(join(pkgDir, 'commands', `${cmdName}.js`), commandTemplate);

  // README
  const readme = `# ${npmName}

A lifo package providing the \`${cmdName}\` command.

## Quick start (inside Lifo)

\`\`\`bash
lifo link ./${name}
${cmdName} --help
\`\`\`

## Publish to npm

For a full TypeScript project with a Vite example app and CLI test harness,
use \`npm create lifo-pkg ${cmdName}\` on your host machine. Then:

\`\`\`bash
npm publish
\`\`\`

Users install with: \`lifo install ${cmdName}\`
`;
  ctx.vfs.writeFile(join(pkgDir, 'README.md'), readme);

  ctx.stdout.write(`Created ${pkgDir}/\n`);
  ctx.stdout.write(`  package.json\n`);
  ctx.stdout.write(`  commands/${cmdName}.js\n`);
  ctx.stdout.write(`  README.md\n`);
  ctx.stdout.write(`\nNext steps:\n`);
  ctx.stdout.write(`  lifo link ./${name}    # register for development\n`);
  ctx.stdout.write(`  ${cmdName} --help      # test it\n`);
  ctx.stdout.write(`\nFor a full TypeScript project, run on your host:\n`);
  ctx.stdout.write(`  npm create lifo-pkg ${cmdName}\n`);

  return 0;
}

// ─── link ───

function lifoLink(ctx: CommandContext, registry: CommandRegistry): number {
  const pathArg = ctx.args[1] || '.';
  const pkgDir = resolve(ctx.cwd, pathArg);

  if (!ctx.vfs.exists(join(pkgDir, 'package.json'))) {
    ctx.stderr.write(`lifo link: no package.json found in ${pkgDir}\n`);
    return 1;
  }

  try {
    const commands = linkPackage(ctx.vfs, registry, pkgDir);
    ctx.stdout.write(`Linked ${pkgDir}\n`);
    for (const cmd of commands) {
      ctx.stdout.write(`  registered command: ${cmd}\n`);
    }
  } catch (e) {
    ctx.stderr.write(`lifo link: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  return 0;
}

// ─── unlink ───

function lifoUnlink(ctx: CommandContext): number {
  const name = ctx.args[1];
  if (!name) {
    ctx.stderr.write('Usage: lifo unlink <name>\n');
    return 1;
  }

  const commands = unlinkPackage(ctx.vfs, name);
  if (!commands) {
    ctx.stderr.write(`lifo unlink: '${name}' is not dev-linked\n`);
    return 1;
  }

  ctx.stdout.write(`Unlinked ${name}\n`);
  for (const cmd of commands) {
    ctx.stdout.write(`  removed command: ${cmd}\n`);
  }

  return 0;
}

// ─── Factory ───

export function createLifoPkgCommand(
  registry: CommandRegistry,
  _shellExecute?: ShellExecuteFn,
): Command {
  return async (ctx) => {
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      printHelp(ctx.stdout);
      return subcommand ? 0 : 1;
    }

    switch (subcommand) {
      case 'install':
      case 'i':
      case 'add':
        return lifoInstall(ctx, registry);
      case 'remove':
      case 'rm':
      case 'uninstall':
        return lifoRemove(ctx, registry);
      case 'list':
      case 'ls':
        return lifoList(ctx);
      case 'search':
        return lifoSearch(ctx);
      case 'init':
        return lifoInit(ctx);
      case 'link':
        return lifoLink(ctx, registry);
      case 'unlink':
        return lifoUnlink(ctx);
      default:
        ctx.stderr.write(`lifo: unknown command '${subcommand}'\n`);
        ctx.stderr.write('Run lifo --help for usage\n');
        return 1;
    }
  };
}

/**
 * Boot-time loader: restores dev-linked commands + re-registers
 * installed lifo packages with the lifo runtime.
 */
/**
 * Re-register all globally installed packages into the command registry.
 *
 * Handles two kinds of packages:
 *   - lifo packages (have a lifo.json manifest) → registered via the lifo runtime
 *   - regular npm packages (have a "bin" field in package.json) → registered via node runner
 *
 * Called on every daemon boot so that packages installed via `npm install -g`
 * or `lifo install` are available as shell commands, including after a snapshot
 * restore where the VFS has the files but the registry is freshly created.
 *
 * Also restores dev-linked packages.
 *
 * Safe to call on a fresh VM — it is a no-op when /usr/lib/node_modules is empty.
 */
export function rehydrateGlobalPackages(vfs: VFS, registry: CommandRegistry): void {
  // 1. Restore dev links
  loadDevLinks(vfs, registry);

  if (!vfs.exists(GLOBAL_MODULES)) return;

  // 2. Scan every package in /usr/lib/node_modules
  for (const entry of vfs.readdir(GLOBAL_MODULES)) {
    if (entry.type !== 'directory') continue;

    const dirs = entry.name.startsWith('@')
      ? (() => {
          try {
            return vfs.readdir(join(GLOBAL_MODULES, entry.name))
              .filter(e => e.type === 'directory')
              .map(e => join(entry.name, e.name));
          } catch { return []; }
        })()
      : [entry.name];

    for (const dirName of dirs) {
      const pkgDir = join(GLOBAL_MODULES, dirName);

      // lifo package: has a lifo manifest → use the lifo runtime
      const manifest = readLifoManifest(vfs, pkgDir);
      if (manifest) {
        for (const [cmdName, entryRelPath] of Object.entries(manifest.commands)) {
          const entryPath = join(pkgDir, entryRelPath);
          if (vfs.exists(entryPath)) {
            registry.register(cmdName, createLifoCommand(entryPath, vfs));
          }
        }
        continue; // lifo manifest takes priority — skip npm bin check
      }

      // regular npm package: has "bin" in package.json → use node runner
      const pkgJsonPath = join(pkgDir, 'package.json');
      if (!vfs.exists(pkgJsonPath)) continue;

      let pkg: { name?: string; bin?: string | Record<string, string> };
      try { pkg = JSON.parse(vfs.readFileString(pkgJsonPath)); } catch { continue; }

      for (const [binName, binPath] of Object.entries(getBinEntries(pkg))) {
        const scriptPath = resolve(pkgDir, binPath);
        if (vfs.exists(scriptPath)) {
          registerBinCommand(registry, binName, scriptPath);
        }
      }
    }
  }
}

/** @deprecated Use rehydrateGlobalPackages() instead. */
export function bootLifoPackages(vfs: VFS, registry: CommandRegistry): void {
  rehydrateGlobalPackages(vfs, registry);
}
