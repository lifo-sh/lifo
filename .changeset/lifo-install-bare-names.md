---
'@lifo-sh/core': patch
---

`lifo install <name>` can now install a lifo command that ships inside an
ordinary npm package, not just a `lifo-pkg-*` one. The runtime always keyed
command discovery on the `lifo` field in package.json rather than the package
name, but the install/remove sugar unconditionally rewrote `foo` to
`lifo-pkg-foo` — so `lifo install orchd` could never find the package actually
called `orchd`. It now tries the convention first and falls back to the bare
name; `lifo remove` resolves against whichever is installed.
