# Releasing

`@lifo-sh/core`, `@lifo-sh/ui` and `lifo-sh` (the CLI) are published to npm from this repo.
Core and the CLI move together and share a version number; ui is released only when it
changes. The apps (`playground`, `desktop`) are not published; the website copies their
builds.

## Steps

1. **Start from main.** Merge `origin/main` into the branch with the change, so the version
   you pick is the next one after what's on npm (`npm view @lifo-sh/core version`).

2. **Bump and write the changelog** on a branch named `release/lifo-core-<version>`:
   - `packages/core/package.json` and `packages/cli/package.json`: the new version. Patch for
     fixes, minor for new commands or APIs.
   - `packages/ui/package.json`, only if ui changed.
   - `packages/core/CHANGELOG.md`: a section for the version, newest first, saying what a
     user will notice.
   - `pnpm install` so `pnpm-lock.yaml` follows.

3. **Check it.**
   ```bash
   pnpm build
   pnpm test
   pnpm --filter lifo-sh pack --dry-run   # the tarball has dist/ and no workspace:* ranges
   ```

4. **Merge the PR.** The commit title says what's in it:
   `release: @lifo-sh/core 0.11.0 + lifo-sh 0.11.0 - <one line>`.

5. **Publish from main**, with pnpm only (npm uploads `workspace:*` literally and the package
   then fails to install; `scripts/ensure-pnpm-publish.mjs` refuses it):
   ```bash
   git checkout main && git pull
   pnpm build
   pnpm --filter @lifo-sh/core publish
   pnpm --filter lifo-sh publish
   pnpm --filter @lifo-sh/ui publish        # only if ui changed
   ```
   Publish core before the CLI: the CLI's dependency on core is rewritten to the exact new
   version, which has to exist. The same goes for the `lifo-pkg-*` packages the CLI ships with
   (git, vi, nano, less, python): publish any whose local version isn't on npm yet
   (`pnpm --filter lifo-pkg-git publish`) before the CLI.

   `lifo-pkg-agent` (the `agent` and `browser` commands, and the `/api/browse` handler) is not
   on npm yet. The website builds against a stub until it is (website/next.config.ts): publish
   it, then `pnpm add lifo-pkg-agent@<version>` in the website before deploying, or the landing
   page's Agent tab, `browser` and `/api/browse` say "not available in this build".

6. **Check the registry**: `npm view lifo-sh version`, then `npx lifo-sh@<version> --help` in an
   empty directory.

## After publishing

- **Website**: bump `@lifo-sh/core` (and `@lifo-sh/ui`) in `website/package.json`, and add any
  newly published `lifo-pkg-*` it registers by default (`lifo-pkg-python` the first time; until
  then npm-mode builds give boxes a `python` that explains it isn't available), run
  `pnpm build:apps` there to refresh `public/playground` and `public/desktop`, and check with
  `pnpm dev:npm`, which uses the npm packages the way production does.
- **Other consumers** (RapidNative): bump there too if the release fixes something they hit.

A published version can't be replaced. If a release is broken, publish a fixed patch and
`npm deprecate <pkg>@<bad version> "<why>"`.
