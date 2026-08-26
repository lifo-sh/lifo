---
"@lifo-sh/core": patch
---

browser-metro: assets written to the VFS after the command started (a chat
attachment uploaded mid-session, an image the agent downloads) are now
registered in the bundler VFS as external entries and reported as a change.
They used to be dropped from the change list, so a `require()` of a new image
crashed the preview with "Module not found: /assets/<file>" until the sandbox
was recreated.
