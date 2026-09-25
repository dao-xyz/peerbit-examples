---
"@peerbit/shared-fs": patch
---

Use exact index queries for cold directory-slot lookups and bound retained slot histories, negative entries, and reverse placements. Partial directory caches never masquerade as complete listings; oversized histories remain readable without truncation. Deduplicate matching in-flight queries while preserving mutation and lifecycle fences.
