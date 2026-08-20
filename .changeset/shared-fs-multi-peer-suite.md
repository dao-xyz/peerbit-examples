---
"@peerbit/shared-fs": patch
---

Add a five-peer convergence test suite and a scaling latency guard.

The multi-peer suite locks in the sync invariants that previously had no CI
coverage: multi-chunk replication to all peers (the pre-0.1.0 fragmentation
regression), deterministic convergence of concurrent same-name file and
directory creates, agreed outcomes for delete-vs-write and rename-vs-write
races, cold joins of access-controlled filesystems reading full history, and
a no-torn-reads invariant while chunks replicate.

The scaling guard grows the store 20x and fails if per-operation medians
(stat, read, list, write) grow more than 4x — catching any return of
O(store)-per-operation behavior long before it reaches the old linear cost.
