---
"@peerbit/shared-fs": patch
---

`drop()` puts the local state file back to gated before the store goes. A
write-ready replica, a creator included, that was dropped and then opened by
address in the same directory used to reopen writable over the empty store,
admitting writes that clash with rows its peers hold and answering other
joiners as a write-ready donor. It now joins afresh.

Garbage collection's heal step repairs a missing chunk only once a version
naming it arrived on the replica at least `chunkGraceMs` ago. A younger one
may still be replicating, as on a replica that just turned writable or is
catching up a backlog: healing it re-put the chunk as a new entry that every
replica received again in full, and with `remoteChunkFetch: false` reported
the node as having unrecoverable missing chunks. Such a node is now only kept
out of deletion for the run, with a warning. A chunk that arrives while its
heal fetch runs is no longer put again.
