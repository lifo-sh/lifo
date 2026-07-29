---
'@lifo-sh/ui': patch
---

Preview router shim: never treat a blob URL's own uuid as the current route.

`parseUrl` resolved a `blob:` URL by reading its inner pathname, which for
`blob:origin/<uuid>` **is the blob uuid**. So any router calling
`history.replaceState(state, '', location.href)` during init — React Navigation
does exactly that — latched `/<uuid>` as the current route.
`window.__ROUTER_SHIM_HASH__` then reported the uuid, and a host that restores
that value on reload (to keep the in-app route across a rebuild) remounted at
`blob:<new-uuid>#<old-uuid>`, so Expo Router rendered "Unmatched Route".

A `blob:` URL identifies the document itself, so its path segment is never a
route. The route now comes from the fragment instead — the same convention the
initial mount already uses when it reads `location.hash`, and what `sync()`
writes back. With no fragment the URL says nothing about the route, so the shim
stays on the current virtual path rather than adopting the uuid.

The `_URL` shim two functions above already did this correctly
(`if (u.indexOf('blob:') === 0) u = virtualHref;`); `parseUrl` disagreed with it.

Observed downstream in a multi-preview canvas: a home (`/`) preview dropped onto
Unmatched Route mid-session while its siblings stayed fine, its hash carried a
uuid belonging to the *previous* mount, and only a full page reload cleared it.
`/` was the visible victim because it is the one mount whose URL carries no
fragment for the shim to read back, and it was intermittent because it only bit
when the router's `replaceState` ran before the first `sync()` had written the
hash.

Note `browser-metro` ships an independent copy of this shim with the same defect;
it needs the equivalent fix for previews served through it.
