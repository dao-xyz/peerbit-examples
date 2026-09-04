---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Add an old-reader-compatible fixed-chunk layout marker and a versioned,
lease-backed native mount range-read capability. Read-only mounts can fetch and
verify only touched chunks while legacy/custom layouts retain an exact verified
whole-file fallback; writable upgrades, namespace changes, lifecycle shutdown,
and garbage collection preserve their existing fail-closed semantics.
