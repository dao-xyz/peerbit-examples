---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Share one backend-local open-file state across descriptors for the same file identity. Sibling reads now observe buffered writes and truncation immediately, backend-local appends allocate from one logical length, provisional creates share one expected-absent commit chain, and overlapping flushes coalesce without manufacturing local conflict heads. `fsync` and `release` use bounded generation cutoffs so later sibling writes cannot starve a fence, verified read snapshots are loaded once per live state, and the state is discarded after its last descriptor closes. Typed existing-node mismatches quarantine stale state across later path repair, while zero-byte writes no longer extend or dirty files.
