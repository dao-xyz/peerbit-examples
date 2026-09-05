---
"@peerbit/shared-fs": patch
---

Remove redundant head filtering and row conversions when assembling writeBatch results. Returned version fields and head flags are unchanged; publication ordering and chunk-presence repair are unaffected.
