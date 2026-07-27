---
"@lifo-sh/core": patch
---

browser-metro: fix an infinite reload loop in blob-served previews.

The HMR client's `/__bmhmr` poll called `location.reload()` when the server's
bundleVersion advanced. Under the SW transport that refetches fresh HTML, but a
blob-URL page (the SW-free preview transport) reloads the SAME blob with the
OLD embedded bundleVersion — whose poll immediately sees `reload: true` again,
reloading forever and making every mounted preview flicker until manually
remounted. Blob-served pages now post `hmr-full-reload` to the host (which
remounts them with fresh HTML) instead of reloading themselves, and stop
polling until remounted.
