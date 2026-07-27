---
"@lifo-sh/core": patch
"@lifo-sh/ui": patch
---

browser-metro: surface build errors instead of breaking the preview.

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
