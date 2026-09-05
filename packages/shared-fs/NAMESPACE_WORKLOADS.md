# Public namespace workloads — held experiment

This benchmark/reproducer branch is based on PR #331 at
`9cde97620e0966b120a050631c1a9cf014cb57b9`. It adds no production implementation,
dependency changes or published package files. **Do not merge this experiment:
the three-peer shutdown control is currently failed.**

## Scope and reproduction

Run from the repository root with the branch's coherent frozen-lockfile install.
Do not mix module installations from different release cohorts or run dedupe.

```sh
pnpm exec vitest run packages/shared-fs/library/src/__tests__/slot-candidate-cache.bench.test.ts --project node --retry 0
```

The ordinary controls use fresh child processes for wide directories (8 files),
stable-node content saves (8), rename/delete/recreate cycles (4), and genuine
partition/rejoin name claims (3 peers). The parent enforces a 90-second child
deadline, including shutdown. A report is not a pass unless the child exits 0.
`PEERBIT_SHARED_FS_SLOT_CACHE_BENCH=1` selects larger controls (10,000 / 1,000 /
100 / 3) and also enables the pre-existing directory-width benchmark.

For separately labeled partial validation, `--testNamePattern 'validates
(wide|versions|churn)'` selects only the local controls. It does **not** establish
that the complete suite or multiplayer shutdown passes.

The worker accepts `wide|versions|churn|claims` plus an integer size. Invoke it
with `node --import tsx packages/shared-fs/library/src/__tests__/slot-candidate-cache.bench.worker.ts SHAPE SIZE`
under a bounded parent process. Claims always uses exactly three peers.

## One sequential local scale campaign, 2026-09-05

Six fresh processes ran once each, ordered as shown, all exiting 0 within their
90-second caps. Final small controls also passed 3/3 with retries disabled.

| Workload | Small / larger fixture | Warm stat p50, ms | Point candidates per stat |
| --- | --- | --- | --- |
| Unique directory | 100 / 10,000 files | 0.0123 / 0.0129 | 2 / 2 |
| One node's content history | 8 / 1,000 saves | 0.0147 / 0.3237 | 2 / 2 |
| Rename/delete/recreate history | 4 / 100 cycles | 0.0213 / 0.1839 | 14 / 302 |

Wide-directory first list took 16.34 / 1,460.46 ms; median across three lists
was 0.445 / 994.79 ms. A full 10,000-file list does not fit the retained cache's
4,096-record limit, and must remain correct without retaining the full result.
Twenty new-file creates had p50 0.989 / 1.667 ms (validation outside timers).
The warmed point path retained only two candidate rows after point probes at
both widths. Point-query improvements do not make full listing constant-time.

For ordinary saves, naming row count stayed 2 while content versions became
9 / 1,001. The slower stat therefore is not growing naming history; head
resolution is a separate profiling target. Rename/delete/recreate instead grew
naming rows from 2 to 18 / 402, and cold-candidate stat from 0.948 to 12.031 ms.
Repeated historical candidate processing is real work even when queries hit
the cache. Do not truncate that history as a performance workaround.

Platform: Node 24.13.1, Darwin 25.6.0, arm64 Apple M3 Pro. Runtime modules were
Peerbit 5.3.35, Documents 15.0.16, shared-log 16.0.15, crypto 3.1.6, Borsh 6.0.1.
Lock SHA-256: `4a4a8df381f6abb29fa12d604a6c8a1b7c5487ed3df6273b7e069422dc475f57`.
Worker SHA-256: `a7e5d8a2f08b06f4e49edc9808e0536b4071a76d936766bbe060893fb568fdf3`.
Raw campaign SHA-256: `2c8bb8d2d76e944f70e8321cf8afeb2b7408363caaaccbfd8e9ca48d7147712b`.
The worker hash identifies the measured snapshot before a subsequent reporting
hardening: successful test output now preserves the complete report, and input
hashes are captured before fixture creation and verified unchanged after stop.
That hardening does not change the measured phase algorithms; these values are
still attributed only to the recorded snapshot, not an unperformed new campaign.

These are descriptive scale observations, not a before/after speedup or a
reliable tail distribution. Stat has 20 samples; listing has only three.
Cold-candidate means only that cache was cleared, not all caches or OS pages.
Validation reads occur outside timers and can warm later operations. Row-query
counters exclude document-resolution queries; candidate counters exclude full
sweep rows. Memory readings are whole-process endpoints, not peak or retained
cache memory. Module provenance records worker resolution, not independent
identity checks for every transitive import. All storage is in memory: no
mounted I/O, disk barriers, remote persisted receipts or network latency claim.

## Three-peer failure: convergence succeeded, shutdown did not

After correcting two harness mistakes (establish address-open readiness before
partitioning; assert `namingConflict`, not content `conflict`), a separate
claims-only run verified all three independent node claims, the same visible
winner and bytes on every peer. All `peer.stop()` promises fulfilled. The child
nevertheless exceeded 90 seconds and was terminated: **failed**, not passed.
Those earlier runs are not the final local timing baseline.

A bounded async-hooks trace found 18 referenced stream inbound-prune timers and
three libp2p AddressManager debounce timers after stop. Later `beforeExit`
occurred but real process exit did not. A read-only native sample showed
`node::Environment::RunCleanup -> CleanupHandles -> uv_run`. This localizes the
lasting hang to native environment cleanup, but does not identify its owner;
the prune timers alone do not explain the entire timeout.

The final diagnostic was manually terminated with SIGTERM (exit 143), at about
131 seconds; unlike the original failing test it was not launched under the
90-second parent cap. Its misleading `namespace-diagnostic-natural-exit` marker
means only `beforeExit`. No forced-success exit or transport-disable workaround
was added. The worker's subsequent caller-deadline fix bounds polling at 30
seconds but cannot cancel an already pending read; this final worker version's
claims scenario has not been rerun.

Read-only comparison with the held Peerbit 5.4.0 install found byte-identical
stream 5.2.1 source and built JS, plus the same libp2p 3.3.8 / utils 7.3.2 code.
Both stream implementations omit inbound-prune cancellation in `close()`.
The whole workload has **not** been reproduced on that newer cohort.

Next downstream targets are measured head-resolution work, full-list decoding
and watcher costs, and historical namespace decision work with explicit bounds
and invalidation tests. Upstream must separately address readiness/session and
shutdown lifetime findings. Neither this experiment nor the cache PR clears
the coherent-cohort cross-platform disposal/reopen release gate.
