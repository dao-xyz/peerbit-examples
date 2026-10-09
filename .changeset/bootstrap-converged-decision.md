---
"@peerbit/shared-fs": patch
---

`awaitBootstrapConverged()` called right after a joining replica opens now
waits for the snapshot bootstrap that the open is still deciding on. The open
decides in the background, after it checks the local index for content. A
call made before that check answered resolved `{ verified: false }` at once,
as if no bootstrap would run. The CLI's conflict listings and its snapshot
command make this call right after opening, so they could read a view that
was still partial.
