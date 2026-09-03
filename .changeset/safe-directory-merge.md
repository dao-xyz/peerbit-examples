---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Add an exact-conflict-fenced directory merge repair that reparents observed
direct children without changing node identities, preserves destination child
collisions, and exposes the action and structured result through the CLI.
