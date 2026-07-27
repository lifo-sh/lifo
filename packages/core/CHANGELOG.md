# @lifo-sh/core

## 0.7.0

### Minor Changes

- d6084b5: grep: implement BRE, the default dialect (and add -F / -G)

  The pattern was passed straight to `new RegExp`, so grep was always ERE. GNU grep defaults to BRE,
  and the two dialects are inverted for the most useful metacharacters:

  | pattern             | BRE (GNU default) | what lifo did                    |
  | ------------------- | ----------------- | -------------------------------- |
  | `\|`                | alternation       | literal text `\|` → **no match** |
  | `\|` (bare `\|`)    | literal pipe      | alternation                      |
  | `\(` `\)`           | group             | literal → no match               |
  | `\+` `\?` `\{n,m\}` | quantifiers       | literal → no match               |

  So `grep "createClient\|supabase-js"` — valid GNU grep, and the natural way to search for two things
  at once — compiled to the literal string `createClient|supabase-js` and matched nothing. It exited 1
  with no output, which is indistinguishable from a genuine absence, so callers acted on the empty
  result. That is the worst failure mode a search tool has.

  - BRE is now the default, translated to JS regex (`breToJs`)
  - `-E` / `--extended-regexp` selects ERE, as before
  - `-F` / `--fixed-strings` is new: every metacharacter literal
  - `-G` / `--basic-regexp` selects BRE explicitly; last mode flag wins, as in GNU
  - `\<` `\>` map to `\b`; bracket expressions are copied verbatim so `[+?]` is not mangled

  **Behaviour change:** a pattern like `grep "a|b"` previously alternated and now matches the literal
  text `a|b`, which is what GNU grep does. Add `-E` to keep the old behaviour. Hence minor, not patch.

  Not covered: BRE's positional rules where a metacharacter is literal because of where it sits (a `^`
  that is not at the start, a `$` that is not at the end). A leading `*` is handled.

### Patch Changes

- browser-metro: fix an infinite reload loop in blob-served previews.

  The HMR client's `/__bmhmr` poll called `location.reload()` when the server's
  bundleVersion advanced. Under the SW transport that refetches fresh HTML, but a
  blob-URL page (the SW-free preview transport) reloads the SAME blob with the
  OLD embedded bundleVersion — whose poll immediately sees `reload: true` again,
  reloading forever and making every mounted preview flicker until manually
  remounted. Blob-served pages now post `hmr-full-reload` to the host (which
  remounts them with fresh HTML) instead of reloading themselves, and stop
  polling until remounted.

- @lifo-sh/ui@0.7.0

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
  - @lifo-sh/ui@0.6.8

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

## 0.6.6

### Patch Changes

- 9e183ab: grep: support long options, and stop treating them as filenames

  `--include`, `--exclude` and `--exclude-dir` are now implemented, along with long
  aliases for the existing short flags (`--ignore-case`, `--line-number`,
  `--recursive`, `--invert-match`, `--files-with-matches`, `--count`,
  `--word-regexp`, `--extended-regexp`) and `-R`.

  Previously the parser only recognised single-dash flags, so `grep -rn
--include="*.ts" foo src` treated `--include=*.ts` as a file operand: it printed
  "no such file or directory" to stderr, searched every file anyway, and still
  exited 0. An unrecognised long option now exits 2 with a message rather than
  quietly searching the wrong set.

  Also fixes `--` handling. It ended option parsing before the pattern was read, so
  `grep -- pattern file` failed with "missing pattern" and pushed the pattern into
  the file list.

  `--exclude-dir` prunes during the directory walk rather than filtering afterwards,
  so excluding `node_modules` avoids reading it.

## 0.6.5

### Patch Changes

- Fix webpack build error caused by static `node:module` import in bundled output

## 0.6.4

### Patch Changes

- Bug fixes and improvements
- Updated dependencies
  - @lifo-sh/ui@0.6.4

## 0.6.0

### Minor Changes

- node-compat fixes: prompt-based CLIs like `create-expo-app` return to the shell prompt on their own (raw-mode leftover + in-flight child-process tracking in the `node` runner); output is silenced after `process.exit()` so error stacks match Node; `npm run` no longer prints internal debug lines. Version realigned across the linked `@lifo-sh` suite.

## 0.3.0

### Minor Changes

- **VFS: Large file support** -- Content-addressable blob storage with FNV-1a hashing, chunked storage for files >= 1MB (256KB chunks), and LRU eviction cache with configurable memory budget (64MB default)
- **VFS: MIME type detection** -- Auto-detect MIME types on file write via extension lookup (70+ extensions), file category utilities (text/image/video/audio/binary), binary-safe command audit for 12 text commands
- **VFS: Mount system** -- Mount table with longest-prefix-first matching, `MountProvider` interface for full CRUD, `NativeFsProvider` for Node.js with path sandboxing and read-only mode
- **VFS: Watch API** -- File system event watching with scoped and global listeners, event types for create/modify/delete/rename
- **Persistence overhaul** -- Pluggable `PersistenceBackend` interface with IndexedDB and Memory backends, updated serializer with chunk manifests
- **Snapshot import/export** -- `exportSnapshot()` / `importSnapshot()` via tar.gz for VFS state
- **Node.js fs shim** -- File descriptor APIs (open/close/read/write/fstat), stream APIs (createReadStream/createWriteStream), watch API, realpath, truncate, symlink stubs
- **Git command** -- Built-in `git` powered by isomorphic-git (init, add, commit, status, log, diff, branch, checkout, remote, push, pull, fetch)
- **CLI: Host filesystem mounting** -- `--mount <path>` flag to mount a host directory at `/mnt/host` via NativeFsProvider, temp session fallback when no mount provided
- **New examples** -- Git basics and branching shell scripts

## 0.2.0

### Minor Changes

- Initial public release of Lifo packages -- a Linux-like OS running natively in JavaScript.
