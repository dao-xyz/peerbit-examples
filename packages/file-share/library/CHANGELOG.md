# @peerbit/please-lib

## 2.0.6

### Patch Changes

- 5eb126c: Increase the bounded large-file upload queue to eight concurrent chunk puts and four MiB after counterbalanced production-browser validation. Clarify index-row diagnostics separately from exact local block presence and require complete post-read blocks in live transfer benchmarks.
- 1faa7e8: Keep exact downloaded chunk blocks through adaptive pruning, use them for local rereads without index reconstruction, and cancel pending local read-ahead promptly.
- ec51265: Make large-file uploads transactional and memory-bounded with normalized source chunks, shared staging/put budgets, pending-to-ready manifests, exact-head rollback, and ownership-safe deletion. New writes use the legacy TinyFile representation through the exact 4 MiB cutoff, while larger nested writes use the compatible parented manifest variant. Tiny Blob materialization is now budgeted before allocation, size-checked before publication, and remains charged when an uncooperative read outlives cancellation. Stream reads now use cancellation-aware shared deadlines, pessimistic legacy-decoder reservations, bounded adaptive prefetch, exact manifest-head lookup, immutable per-transfer persistence policy, constant-space retention, integrity checks, and cancellation cleanup that keeps uncooperative decoder and sink work charged until it settles.

    Improve the file-share clients with stable provider configuration, explicit direct-peer dial evidence, local-first root listing, stale-safe remote reconciliation, coalesced refreshes, transfer cleanup, and quieter unconstrained adaptive rebalancing. Expand production transfer benchmarks with deterministic 64/256 MiB fixtures, cohort and topology validation, browser and process memory measurements, strict browser/external-file streaming verification, and exact demand-persistence checks.

- f860ee8: Expose per-chunk demand wait, byte length, source, and computed stream hash diagnostics for integrity-gated file-share performance measurements.

## 2.0.5

### Patch Changes

- d1ca154: Wait for the full chunk set before streaming large files in observer downloads, so CLI reads do not fail after a file becomes discoverable but before all chunks are fetchable.

## 2.0.4

### Patch Changes

- Refresh file-share packages to the latest Peerbit release line and stabilize the monorepo install layout used by the CLI and frontend.

## 2.0.3

### Patch Changes

- Release the file-share CLI packages with the latest Peerbit dependency line.

## 2.0.2

### Patch Changes

- af6fcb4: Prefer direct peer dialing for file sharing, improve large streamed transfer reliability, and update file-share examples for the released Peerbit 5.2.0 graph.

## 2.0.1

### Patch Changes

- Bump Peerbit

## 2.0.0

### Major Changes

- Bump peerbit @peerbit/document v12. Change of wiretypes for indexed types

## 1.0.0

### Major Changes

- Update for to reflect upstream Peerbit version

## 0.0.18

### Patch Changes

- Bump
