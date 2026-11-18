---
"@peerbit/shared-fs-cli": minor
---

`peerbit-fs conflicts --fail-if-any` gates CI on conflicts: it exits with
status 3 when the local view holds any conflict, content or naming; with 0
when it holds none in a view verified complete (a full replica joined
through a verified snapshot bootstrap); and with 4 when it holds none in any
other view, since absence there proves nothing. `--allow-unverified` accepts
such a view and exits 0. Errors still exit with 1. It prints the content
listing as before, then each naming conflict's type and path, and with
`--json` adds a `namingConflicts` array. `--path` scopes both kinds.
`naming-conflicts` takes no such flag: one gate covers every kind.

A mount now shows naming conflicts under `/.peerbit-conflicts` as well, in a
new flat, read-only layout that `/` no longer lists (see `@peerbit/shared-fs`).
This replaces the old layout without a compatibility window, a break allowed
because shared-fs has no production users.
