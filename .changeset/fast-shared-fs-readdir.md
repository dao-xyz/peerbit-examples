---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Optionally include snapshot-consistent stat metadata in Shared FS directory
entries and publish native adapter binaries that request it only when cgofuse
can use readdir-plus on Linux FUSE 3 or WinFsp, avoiding per-entry IPC lookups
without bloating compact listings on other mounts.
