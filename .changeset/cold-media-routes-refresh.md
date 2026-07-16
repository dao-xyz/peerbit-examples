---
"@peerbit/media-streaming": patch
---

Make media seeking fail closed when the canonical origin cannot prove a page,
rather than treating partial or still-syncing relay and local caches as
complete. Bound retries and pagination, align finite-track endpoints, and make
abort and iterator cleanup deterministic.
