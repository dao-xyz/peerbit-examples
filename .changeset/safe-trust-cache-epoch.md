---
"@peerbit/shared-fs": patch
---

Reject trust checks invalidated by a local trust-graph change or retirement of their filesystem open, preventing stale positive or negative verdicts from refilling the cache. Keep stable verdict caching and trust invalidation active while already-admitted writes drain during close, and fail closed without retrying an invalidated admission. This closes a downstream cache race, not the separate distributed revocation-convergence window.
