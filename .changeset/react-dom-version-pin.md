---
"@lifo-sh/core": patch
---

Bump browser-metro to 1.4.2: transitive react-dom is now pinned to the project's declared react version, fixing the "Incompatible React versions" preview boot crash in projects whose package.json declares react but not react-dom (react-dom drifted to npm latest via the package server's isolated peer resolution).
