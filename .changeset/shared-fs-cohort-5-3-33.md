---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Upgrade the Peerbit cohort to peerbit 5.3.33 / @peerbit/document 15.0.13
(shared-log 16.0.13 with batch signature verification under application
authorization, indexer-sqlite3 3.0.18 with ordered write sessions, program
6.0.54, trusted-network 6.0.99) and rebaseline the multi-party workload.

Measured on the 2,000-file / ~6,200-document cold join (three instrumented
runs per cohort, identical instrumentation): complete convergence median
12.7s → 9.6s (~25% faster) with ~24% less joiner CPU and 1.9x faster SQLite
insert statement time; receive-batch shape (13 batches, p50 ~84 docs) and
message counts unchanged, so the gain is genuinely per-entry ingest cost —
consistent with upstream's 21.5% elapsed improvement claim. The 500-file
live-join case (ten counterbalanced runs per cohort) is unchanged within
noise and revealed a pre-existing bimodal structure on BOTH cohorts (~0.8s
fast path vs 3-4.5s slow path) now reported upstream.

No shared-fs code change; full suite green. The install recipe matters:
pin the whole cohort (including program/trusted-network) before installing,
never run `pnpm dedupe` (it evicts the subtree peerbit copy and splits the
class registries — replication silently drops every document).
