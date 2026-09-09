---
"@peerbit/shared-fs": patch
---

Adopt the published Documents immutable-admission correction and matching
Trusted Network release. An empty early query response no longer hides a known
older immutable conflict in later returned results. This does not establish
global uniqueness during partitions, repair historical conflicts, or change
persisted-delivery guarantees.
