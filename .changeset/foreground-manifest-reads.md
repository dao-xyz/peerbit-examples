---
"@peerbit/please-lib": patch
---

Prioritize manifest and exact-entry reads ahead of background file replication,
and keep large persisted reads moving through a memory-bounded rolling manifest
window.
