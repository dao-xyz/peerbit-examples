---
"@peerbit/shared-fs-cli": patch
---

Add an opt-in, 1–16 lane native IPC pool for overlapping independent FUSE/WinFsp operations while retaining single-threaded behavior by default, file-handle lane affinity, bounded shutdown, and fail-closed no-replay semantics.
