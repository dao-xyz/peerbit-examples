---
"@peerbit/shared-fs": patch
---

Bound per-node cache epoch metadata under high-cardinality filesystem churn.
Epochs are evicted in batches only after advancing a global generation, so an
in-flight row-cache fill cannot mistake a pruned counter for an unchanged node
and install stale metadata.
