---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Reduce large mount-write peak memory by transferring exact-sized immutable commit buffers to trusted targets and detaching on later handle mutation, while preserving isolated copies for custom targets by default.
