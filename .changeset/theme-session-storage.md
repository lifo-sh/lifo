---
'@lifo-sh/core': patch
---

NativeWind shim: color-scheme preference moves from localStorage to sessionStorage, so editor tabs no longer share one theme key across projects (cross-tab theme flicker); same-tab iframe sync is preserved.
