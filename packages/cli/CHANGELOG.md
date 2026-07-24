# lifo-sh

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
