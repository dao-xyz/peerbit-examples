---
"@peerbit/shared-fs": patch
---

Harden snapshot segment-ledger locking and recovery. Lifecycle cancellation now reaches contended publish and reap ledger writes, existing ownerless lock paths fail closed on POSIX, and deterministic lock/fault checkpoints cover stale-owner races, atomic replacement, and process-crash recovery.
