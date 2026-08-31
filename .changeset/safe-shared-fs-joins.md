---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Fail closed on fresh-join writes until a full replica has a settled initial
view, expose retryable write-readiness APIs and EAGAIN across mount adapters,
and make writable mount commits use the exact visible version with a path/node
compare-and-set so replacement races cannot overwrite the new file. Add an
audited one-time legacy-replica trust workflow; keep partial-write recovery
session-only and block it from snapshots, GC, ACL changes, and disposal.
Persist readiness transitions with crash-safe, synchronized fail-closed
sidecar updates and recognize same-log replicators reached through relays, not
only direct neighbors.

Fence live trusted-writer grants and revocation tombstones alongside filesystem
content during durable machine disposal, and cancel/join cold-bootstrap work so
close and same-instance reopen cannot leak late state changes.
