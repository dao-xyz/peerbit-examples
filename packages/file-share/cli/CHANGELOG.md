# @peerbit/please

## 2.0.7

### Patch Changes

- Updated dependencies [67ac6e5]
- Updated dependencies [0b5ce3e]
- Updated dependencies [6e65ce9]
- Updated dependencies [f618ab6]
- Updated dependencies [0a9f7fa]
- Updated dependencies [8717991]
- Updated dependencies [a9ff1fc]
- Updated dependencies [e96bacb]
- Updated dependencies [282bd66]
    - @peerbit/please-lib@2.0.7

## 2.0.6

### Patch Changes

- 5eb126c: Increase the bounded large-file upload queue to eight concurrent chunk puts and four MiB after counterbalanced production-browser validation. Clarify index-row diagnostics separately from exact local block presence and require complete post-read blocks in live transfer benchmarks.
- a111069: Move the first-party demo URLs under `*.apps.peerbit.org` and use the new
  file-share origin for generated share links.
- ec51265: Make large-file uploads transactional and memory-bounded with normalized source chunks, shared staging/put budgets, pending-to-ready manifests, exact-head rollback, and ownership-safe deletion. New writes use the legacy TinyFile representation through the exact 4 MiB cutoff, while larger nested writes use the compatible parented manifest variant. Tiny Blob materialization is now budgeted before allocation, size-checked before publication, and remains charged when an uncooperative read outlives cancellation. Stream reads now use cancellation-aware shared deadlines, pessimistic legacy-decoder reservations, bounded adaptive prefetch, exact manifest-head lookup, immutable per-transfer persistence policy, constant-space retention, integrity checks, and cancellation cleanup that keeps uncooperative decoder and sink work charged until it settles.

    Improve the file-share clients with stable provider configuration, explicit direct-peer dial evidence, local-first root listing, stale-safe remote reconciliation, coalesced refreshes, transfer cleanup, and quieter unconstrained adaptive rebalancing. Expand production transfer benchmarks with deterministic 64/256 MiB fixtures, cohort and topology validation, browser and process memory measurements, strict browser/external-file streaming verification, and exact demand-persistence checks.

- 7b8bbe5: Replace retired demo origins with configurable URLs on Peerbit-owned domains.
- Updated dependencies [5eb126c]
- Updated dependencies [1faa7e8]
- Updated dependencies [ec51265]
- Updated dependencies [f860ee8]
    - @peerbit/please-lib@2.0.6

## 2.0.5

### Patch Changes

- d1ca154: Wait for the full chunk set before streaming large files in observer downloads, so CLI reads do not fail after a file becomes discoverable but before all chunks are fetchable.
- Updated dependencies [d1ca154]
    - @peerbit/please-lib@2.0.5

## 2.0.4

### Patch Changes

- Refresh file-share packages to the latest Peerbit release line and stabilize the monorepo install layout used by the CLI and frontend.
- Updated dependencies
    - @peerbit/please-lib@2.0.4

## 2.0.3

### Patch Changes

- Release the file-share CLI packages with the latest Peerbit dependency line.
- Updated dependencies
    - @peerbit/please-lib@2.0.3

## 2.0.2

### Patch Changes

- af6fcb4: Prefer direct peer dialing for file sharing, improve large streamed transfer reliability, and update file-share examples for the released Peerbit 5.2.0 graph.
- Updated dependencies [af6fcb4]
    - @peerbit/please-lib@2.0.2

## 2.0.1

### Patch Changes

- Bump Peerbit
- Updated dependencies
    - @peerbit/please-lib@2.0.1

## 2.0.0

### Major Changes

- Bump peerbit @peerbit/document v12. Change of wiretypes for indexed types

### Patch Changes

- Updated dependencies
    - @peerbit/please-lib@2.0.0

## 1.0.0

### Major Changes

- Update for to reflect upstream Peerbit version

### Patch Changes

- Updated dependencies
    - @peerbit/please-lib@1.0.0

## 0.0.23

### Patch Changes

- Bump
- Updated dependencies
    - @peerbit/please-lib@0.0.18
