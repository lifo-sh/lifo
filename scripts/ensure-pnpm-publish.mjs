// Refuse to publish through npm.
//
// Every package in this workspace depends on its siblings with `workspace:*`. pnpm rewrites that to
// a real version range when it packs; npm does not — it uploads the literal string, and the
// published package then fails to install with:
//
//   npm error code EUNSUPPORTEDPROTOCOL
//   npm error Unsupported URL Type "workspace:": workspace:*
//
// That is exactly what happened to lifo-sh@0.6.6, and nothing caught it: `npm publish` succeeded,
// the tarball looked fine, and the breakage only surfaced for whoever installed it next. A publish
// that cannot be undone deserves a check that runs before it, not after.
//
// Use `pnpm publish` (or `changeset publish`, which shells out to pnpm here).

const agent = process.env.npm_config_user_agent ?? '';

if (!agent.startsWith('pnpm/') && !agent.includes(' pnpm/')) {
  console.error(
    '\n  Refusing to publish: this workspace must be published with pnpm.\n' +
      `  Detected client: ${agent || '(unknown)'}\n\n` +
      '  npm does not rewrite `workspace:*` dependencies, so the published package\n' +
      '  would be uninstallable. Run instead:\n\n' +
      '    pnpm publish --otp=<code>\n'
  );
  process.exit(1);
}
