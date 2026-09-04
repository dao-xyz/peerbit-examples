---
"@peerbit/shared-fs": patch
---

Add a report-only matched benchmark for one-chunk `verify` versus always-touch
writes, including direct and mount-backend timings, operation counts, log
growth, and state-directory growth.
