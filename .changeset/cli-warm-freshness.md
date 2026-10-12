---
"@peerbit/shared-fs-cli": minor
---

`mount --require-fresh` keeps a warm remount from becoming writable until the
replica has compared its view with the peers of the filesystem it can see,
within `--write-ready-timeout-ms` (the library's
`writeReadiness.requireFreshOnReopen`). It cannot be combined with
`--assume-complete` or `--allow-partial-writes`. `mount` and `status` print
`freshness: <state>` for a warm replica, and `status --json` includes
`freshness`. Every command but `mount` checks freshness only if a peer asks it,
so a script that runs `status` repeatedly adds no freshness requests.
