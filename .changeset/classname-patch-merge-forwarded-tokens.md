---
"@lifo-sh/core": patch
---

browser-metro className patch: merge forwarded `$$css` token objects instead of dropping them. When a custom component's caller-supplied `className` (already converted to a `$$css` style object) was spread via `{...rest}` onto an inner element that had its own `className`, the patch treated it as a plain user style and deferred it to per-property `el.style["gap-3"] = "gap-3"` writes — invalid CSS properties, silently discarded — so the caller's classes never rendered. Token objects are now merged into one `$$css` object, caller tokens last, matching `cn(base, className)` precedence.
