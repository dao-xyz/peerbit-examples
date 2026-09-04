---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Ship a self-contained Apache-2.0 license with both Shared FS packages. Exclude
the CLI's internal cross-OS CI driver from its tarball and accurately declare
the executable modules that have import-time side effects.
