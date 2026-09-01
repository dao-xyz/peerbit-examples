---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Delegate native-mount commit hashing and exact-head no-op checks to capable SharedFS targets, avoiding one redundant full-file SHA-256 pass on version-creating commits while preserving legacy target behavior.
