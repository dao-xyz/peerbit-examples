---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Add an exact node-guarded remove/rename capability for native mounts, including
typed compare-and-set mismatches, atomic replacement event publication,
artifact-ignore forwarding, active descendant binding, and detached open-file
handling after unlink or replacement.
