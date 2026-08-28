---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Fix a cache fill/event race: the per-node row caches computed a fill epoch
but never checked it, so a cache-miss fill whose row query raced a
concurrently arriving document could install a stale bucket that silently
hid the superseding row (a newer version or rename) for as long as the
bucket stayed warm. Fills now install only when the node's epoch is
unchanged across the fill's awaits, matching the directory-sweep cache.
