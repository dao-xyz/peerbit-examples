---
"@peerbit/blog-sdk": patch
---

Carry indexed post authors in remote query results so non-replicating readers
can search posts and resolve their authors without requiring the source log head
locally.
