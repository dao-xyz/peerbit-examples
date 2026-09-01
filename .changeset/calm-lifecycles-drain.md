---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Serialize filesystem lifecycle transitions and drain admitted write, disposal,
snapshot, and garbage-collection critical tails before storage closes. Persist
snapshot segment ownership through a locked, atomic, fsynced ledger and recover
or fail closed when reclamation races concurrent document updates.
