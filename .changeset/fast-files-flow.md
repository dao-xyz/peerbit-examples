---
"@peerbit/please": patch
"@peerbit/please-lib": patch
---

Make large-file uploads transactional and memory-bounded with normalized source chunks, shared staging/put budgets, pending-to-ready manifests, exact-head rollback, and ownership-safe deletion. New writes use the legacy TinyFile representation through the exact 4 MiB cutoff, while larger nested writes use the compatible parented manifest variant. Tiny Blob materialization is now budgeted before allocation, size-checked before publication, and remains charged when an uncooperative read outlives cancellation. Stream reads now use cancellation-aware shared deadlines, pessimistic legacy-decoder reservations, bounded adaptive prefetch, exact manifest-head lookup, immutable per-transfer persistence policy, constant-space retention, integrity checks, and cancellation cleanup that keeps uncooperative decoder and sink work charged until it settles.

Improve the file-share clients with stable provider configuration, explicit direct-peer dial evidence, local-first root listing, stale-safe remote reconciliation, coalesced refreshes, transfer cleanup, and quieter unconstrained adaptive rebalancing. Expand production transfer benchmarks with deterministic 64/256 MiB fixtures, cohort and topology validation, browser and process memory measurements, strict browser/external-file streaming verification, and exact demand-persistence checks.
