# @lifo-sh/core

## 0.6.1

### Patch Changes

- Fix ESM masker desync on a regex after a comment
  - @lifo-sh/ui@0.6.1

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
