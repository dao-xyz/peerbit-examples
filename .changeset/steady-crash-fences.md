---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Fence mounted `fsync` and `release` across concurrent buffered writes so every
buffer mutation accepted before the fence is included in a published stable
generation, and late writes to a closing handle fail instead of disappearing.
Add a portable forced-process-termination campaign that reopens a disk-backed
`fsync` result and both remote custodians after a persisted `minAcks: 2`
disposal barrier, while documenting that process recovery is not a universal
host power-loss guarantee.
