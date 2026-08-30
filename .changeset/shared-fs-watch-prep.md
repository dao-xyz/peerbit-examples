---
"@peerbit/shared-fs": patch
---

Internal read-path extraction: list() and resolvePath() now delegate to a
shared winner pipeline (listByParentId / resolvePathDetailed), and the
in-memory row shapes carry the changesetId the index rows already store.
Behavior-preserving; groundwork for the change-notification layer.
