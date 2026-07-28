# lifo-sh

## 0.7.1

### Patch Changes

- node: fix ESM transform crashing on a regex literal inside a `${…}` template expression

  `npx tinbase --engine pgmem` — the backend behind both Supabase examples — died on startup with:

  ```
  TypeError: [/…/node_modules/tinbase/dist/index.js] Cannot read properties of undefined (reading 'slice')
  ```

  The ESM→CJS string masker was at fault, not tinbase (which runs fine on the host on both 0.8.1 and
  0.10.0). `scanBracedExpr` called the three-parameter `isRegexStart(prevChar, prevIdx, src)` with two
  arguments:

  ```js
  const kind = isRegexStart(src, i); // src lands in prevChar, i in prevIdx, src is undefined
  ```

  `prevChar` then held the entire source, so the `/[A-Za-z_$]/` keyword check passed on any file
  containing a letter and fell through to `src.slice(…)` on `undefined`. Every `/` inside a `${…}`
  template expression — division or regex — threw.

  Only the pgmem path happened to contain that shape, which is why just that engine broke:
  `pg-mem/index.js`, `tinbase/dist/db/pgmem-engine.js` and `tinbase/dist/db/schema-diff.js` all build
  SQL with `` `${l.replace(/'/g, "''")}` ``. A sweep of `transformEsmToCjs` over all 175 files in the
  example's `node_modules` fails on exactly those three before the fix and none after.

  `scanBracedExpr` now tracks `prevChar`/`prevIdx` the same way `maskStringLiterals` does — comments
  transparent, a string or regex literal reported as a value — and passes all three arguments.

  **Debugging note for next time:** the error names the _parent_ module being executed, not the module
  whose transform threw. `tinbase/dist/index.js` was never the problem.

- Updated dependencies
  - @lifo-sh/core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [d6084b5]
  - @lifo-sh/core@0.7.0

## 0.6.8

### Patch Changes

- Updated dependencies [fec16db]
  - @lifo-sh/core@0.6.8

## 0.6.7

### Patch Changes

- Republish so the packages install from npm.

  Both were last published with `npm publish`, which does not rewrite the `workspace:*` protocol the
  way pnpm does. The tarballs therefore carried it literally:

  - `lifo-sh` shipped `"@lifo-sh/core": "workspace:*"` as a dependency
  - `@lifo-sh/core` shipped `"@lifo-sh/ui": "workspace:*"` as a peer dependency

  Either one fails a default `npm install` with `EUNSUPPORTEDPROTOCOL: Unsupported URL Type
"workspace:"`. The peer was the less obvious of the two — it is still a hard failure, and it only
  went unnoticed because the consumers that had it installed set `legacy-peer-deps=true`.

  No source change; this release exists only to ship manifests pnpm has resolved to real versions.
  A `prepublishOnly` guard now refuses to publish through npm so it cannot recur.

- Updated dependencies
  - @lifo-sh/core@0.6.7

## 0.6.6

### Patch Changes

- Updated dependencies [9e183ab]
  - @lifo-sh/core@0.6.6

## 0.6.5

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.6.5

## 0.6.4

### Patch Changes

- Updated dependencies
  - @lifo-sh/core@0.6.4

## 0.6.0

### Minor Changes

- Version alignment across the linked `@lifo-sh` suite (no functional changes).

## 0.3.0

### Minor Changes

- **Host filesystem mounting** -- `--mount <path>` / `-m <path>` flag to mount a real host directory at `/mnt/host`, enabling direct disk I/O with no memory limits on file size
- **Temp sessions** -- When no `--mount` flag is provided, a temporary directory is created and cleaned up on exit
- **PWD defaults to mount** -- Shell starts in `/mnt/host` for immediate access to mounted files

## 0.2.0

### Minor Changes

- Initial public release of Lifo packages -- a Linux-like OS running natively in JavaScript.
