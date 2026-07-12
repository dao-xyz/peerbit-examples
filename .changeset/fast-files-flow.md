---
"@peerbit/please": patch
"@peerbit/please-lib": patch
---

Make large-file uploads transactional and memory-bounded with normalized source chunks, bounded concurrent puts, pending-to-ready manifests, exact-head rollback, and ownership-safe deletion. Stream reads now use cancellation-aware shared deadlines, bounded adaptive prefetch, exact manifest-head lookup, immutable per-transfer persistence policy, constant-space retention, integrity checks, and separate indexed-versus-local-block diagnostics.

Improve the file-share clients with stable provider configuration, explicit direct-peer dial evidence, local-first root listing, stale-safe remote reconciliation, coalesced refreshes, transfer cleanup, and quieter unconstrained adaptive rebalancing. Expand production transfer benchmarks with deterministic 64/256 MiB fixtures, cohort and topology validation, browser and process memory measurements, strict browser/external-file streaming verification, and exact demand-persistence checks.
