# @lifo-sh/ui

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

- fec16db: browser-metro: surface build errors instead of breaking the preview.

  - A failed initial build no longer exits without binding the port (which left
    the preview stuck on the "nothing on this port" spinner / host timeouts).
    Like real Metro, the dev server now always binds and stays alive; build
    errors are state, not fatal.
  - Build/rebuild errors are published on `GET /__bmhmr` as `buildError`
    (message + code frame, `null` when the bundle is good) so hosts embedding
    the preview can display them in their own UI — and know when they clear.
  - stderr distinguishes `bundle failed:` (no working bundle exists — every
    screen is down) from `rebuild failed:` (the last good bundle keeps serving;
    only the broken module's screen is affected), so hosts can scope error UI.
  - After a failed initial build, fixing the file triggers a fresh full build
    and reloads clients automatically.

  ui: the no-SW preview no longer executes a failed bundle response (Metro's
  500 JSON error) as JavaScript — it renders the error message in the iframe
  instead.

- Updated dependencies [fec16db]
  - @lifo-sh/core@0.6.8

## 0.6.4

### Patch Changes

- Bug fixes and improvements
- Updated dependencies
  - @lifo-sh/core@0.6.4

## 0.6.0

### Minor Changes

- Add `PreviewBrowser` — an embeddable, framework-agnostic preview of an in-VM port (a service-worker-backed iframe with optional back/forward/reload chrome and a friendly address bar). `@lifo-sh/ui` now covers Terminal, PreviewBrowser, and FileExplorer.

## 0.3.0

### Minor Changes

- **File Explorer** -- Visual file manager with Monaco editor integration, drag-and-drop upload, right-click context menu, live sync with terminal
- **New demo examples** -- Git and CLI (Node.js) examples in the vite-app showcase
- **Layout fixes** -- Fixed output column scroll cropping issue

## 0.2.0

### Minor Changes

- Initial public release of Lifo packages -- a Linux-like OS running natively in JavaScript.
