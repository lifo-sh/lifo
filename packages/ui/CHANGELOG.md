# @lifo-sh/ui

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
