---
"@lifo-sh/core": patch
---

grep: support long options, and stop treating them as filenames

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
