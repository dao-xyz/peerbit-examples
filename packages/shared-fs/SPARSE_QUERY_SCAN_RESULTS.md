# Bounded sparse-scan profile — 2026-09-07

## Outcome

The final two 5,000-file samples passed the unchanged filesystem checks and measured all **635 sequential query calls** in each 127-file scan. Scans took **1.83 and 2.08 seconds**. Four metadata calls and one chunk call were made per file; metadata represented **81.06% and 78.35% of measured `next` time**, not CPU time or total scan time. This makes reducing safe metadata round trips a concrete study, not a promised speedup.

No individual scan `next` call exceeded 100 ms in either final sample. This does not explain the earlier longer aggregate scans or the separately observed initial 2,855 ms metadata query. Those earlier scans lacked per-query attribution. These are two fresh samples with different instrumentation, not a latency distribution or production optimization.

Both runs did capture **slow opens in different measured regions**:

| Milliseconds | Final first sample | Final second sample |
| --- | ---: | ---: |
| Outer observer open | **5,036.133** | **4,627.349** |
| Reported SharedLog open total | 4,916.462 | **60.421** |
| Reported SharedLog RPC subscriptions | **4,910.994** | 54.764 |
| Subsequent original `entries.waitFor` | 0.793 | 5.931 |
| First path lookup/read | 101.996 | 123.269 |
| Later 127-file scan | 1,832.756 | 2,080.091 |
| Sum of 635 non-overlapping `next` calls | 1,319.199 | 1,532.853 |
| Largest scan `next` call | 5.472 | 45.088 |

The first open outlier is localized to the reported RPC-subscription phase. The second has about 4.57 seconds **outside that reported SharedLog segment**; it cannot be assigned the same cause, nor attributed to the subsequent readiness wait. Both open profiles emitted nine spans, with no callback errors or drops. Missing provider-resolution/fanout spans are not zero-duration evidence. Upstream received both raw profiles and these limitations.

## What changed here

Based on local bot-authored `d7078620d6725c02468d210c5e530a8aeead6b4d`. Only test helpers, their tests and reports changed. Production mounts, schema, authority, readiness, query predicates/options, timeouts, replication, dependency pins and release gates did not change. All helpers remain excluded from the library build and published package.

Opt-in `PEERBIT_SHARED_FS_SPARSE_SCAN_PROFILE=1` requires the existing phase and transport profile flags. One `SparseQueryClient` and its existing LRU/counters survive initial reads, the scan and subsequent edit/reconnect checks. An initial facade is used before the scan; each active scan window wraps the **original** entries, without stacking the stopped initial profiler.

Each temporal file window includes lookup, read and correctness/cache assertions. The recorder aggregates every window, retains only the eight slowest plus the first failure, and caps each phase trace at 128 events. Its dedicated transport recorder allows 128 events / 64 outer IDs per live window. Only primitive metadata is retained; no predicates, paths, payloads, envelope decoding, private query fields or error objects are collected.

Transport draining preserves the clock and cumulative lifetime counters, but clears window-local event/ID/duplicate sets. Messages crossing a boundary can therefore produce incomplete chains. Only same-outer-ID chains **within one direction** are measured; a temporal file window does not pair requests with responses or establish causal file attribution. Public RPC response events may also be interceptor/prediction-associated, so unmatched standalone responses are not wire-receipt proof. Sender hashes and signed transport sessions are checked within complete chains; sessions are not request IDs.

All-file aggregates distinguish logical query creation, paginated `next` calls and closes. Fixed latency buckets are ≤1, (1,10], (10,100], (100,1000], >1000 ms. Failures, phase truncation and observer errors are counted even for windows evicted from the retained eight. Diagnostic faults cannot replace the original operation result/rejection, including `undefined`; separate network assertions reject incomplete instrumentation. Final stopped transport counters are checked too, covering the unassigned tail after the last drain. Cleanup attempts every recorder and both peers.

### Instrumentation cleanup and preserved earlier variant

Final review found that the reused phase profiler did not disable its `AsyncLocalStorage` instance when stopped. Repeated per-file instances made that lifecycle omission material. `stop()` now disables its own instance once, and `measure()` after stop forwards directly without reactivation. The regression proves cleanup calls and error/value preservation, **not actual garbage collection or a whole-process memory bound**.

All pre-cleanup artifacts remain intact. Those earlier scans took 2,409.566 / 2,525.198 ms and showed metadata shares of 80.53% / 82.73% of `next` time. They are explicitly **nonfinal instrumentation measurements**. The cleanup variant has separate raw logs and provenance; no performance improvement is claimed by comparing the variants. All network runs passed first attempt; fresh cleanup runs were not retries of a failing campaign.

## Final scan coverage and limits

Per final 5,000-file run:

- 127 naming-slot, 254 naming-node, 127 version and 127 chunk queries: **635 creates / next calls / closes**, with no unknown kinds or failures.
- First sample: all 635 `next` calls ≤10 ms. Second: 632 ≤10 ms, three in (10,100] ms, none above 100 ms.
- Eight retained windows, each with 37 phase events, 30 transport events, five complete request-direction chains and five independent response-direction chains. All identity/session checks pass. No unmatched chains in retained windows, and no unassigned tail events.
- Zero diagnostic errors, phase/transport drops, malformed events or duplicates. The discarded pre-scan preamble reported 54 events; only its count/counters are retained.

Within the **retained windows only**, request publish → source data maxima were 2.147 / 15.663 ms; independent response publish → observer data maxima were 2.795 / 27.589 ms. These are not whole-scan transport maxima or server/wire execution measurements. Local query summary timestamps and stored duration values use slightly different capture boundaries and can differ by microseconds.

Each source held 15,002 documents / 20,480,000 payload bytes. The reader checked 128 distinct files, eviction/reread, remote edit, cross-directory rename, delete and reconnect refresh. Its scan-boundary cache held four chunks / 16,384 bytes with 124 evictions. Observer residency remained zero documents, log entries and replication ranges, plus the same one 178-byte block. This is a read-only explicit-refresh observer, not live push, a writable sparse mount, metadata-authority proof, global completeness, N-receipt durability or physical reclamation.

Both peers ran in one local Node process with memory stores and default transports. Cross-recorder timestamps require `clockOriginMs + atMs`; never compare independent process clocks this way. The extra passive recorder also observes the initial read before scan capture begins. First-read timing therefore is not an instrumentation-matched comparison to the prior report. Window duration excludes final snapshot/drain/top-eight maintenance, but outer scan time includes them; outer scan minus summed `next` durations is **not isolated instrumentation overhead**. Hardware/background load was not controlled as a performance laboratory, and no WAN/disk/three-OS benchmark is claimed.

## Verification and reproduction

Final focused validation: **118 tests passed** (11 cache, 45 client, 24 phase profile, 22 transport profile, 15 scan profile, one default network). Strict summaries show zero retries and missing instrumentation; the process exited naturally with code 0. The cleanup 64-file control and both cleanup 5,000-file runs also passed first attempt with natural exit 0. Explicit test-file typechecks, ESLint `--no-ignore`, formatting and the library build pass. No full-library or three-OS campaign was run for this test-only change.

Runtime: Node 24.13.1, pnpm 10.26.1, Vitest 4.0.18, Darwin arm64. Unchanged old cohort: Peerbit 5.4.2, Documents 15.1.0, SharedLog 16.0.30, RPC 6.1.28, Program 6.0.60, Trusted Network 6.0.131, Pubsub 5.4.6, Blocks 4.3.1, Crypto 3.1.6. No install, dedupe, override, dependency-source edit, timeout increase, retry, transport disablement or forced-success exit occurred. These results do not test the pending upstream release.

Lock SHA-256: `f5c3a197949daccb71ae4fd2585704287d025c83499b2d84d5e0f5b255f924b9`.

```sh
source /Users/marcuspousette/git/peerbit-examples/.envrc
cd /private/tmp/peerbit-sparse-client-20260906
PEERBIT_SHARED_FS_SPARSE_PROFILE=1 \
PEERBIT_SHARED_FS_SPARSE_TRANSPORT_PROFILE=1 \
PEERBIT_SHARED_FS_SPARSE_SCAN_PROFILE=1 \
PEERBIT_SHARED_FS_SPARSE_FILES=5000 \
  pnpm exec vitest run --config scripts/shared-fs-strict-tests/vitest.config.mjs \
  packages/shared-fs/library/src/__tests__/sparse-query-network.test.ts
```

Artifact prefix: `/private/tmp/peerbit-sparse-scan-20260907-`.

| Final raw suffix | SHA-256 |
| --- | --- |
| `cleanup-control64-first.log` | `00d119b8e56145e87336e66b5543c6dcf5260e6966473d99a50d8f6890fc5140` |
| `cleanup-5000-first.log` | `9677232b50eb8061be0462566b97f630be908c573f0493aea0f6200645fe9800` |
| `cleanup-5000-second.log` | `8adc50c38017ad8d07dfbfcbfcbfafd37b01bd3578372e42e12251d26bf9fa57` |
| `cleanup-validation-first.log` | `d504d2a23d2a22b22fcf7b1fdef8e34a96fb5e77ebea0352e50b0720df0c517d` |

Each final sample has a matching `-summary.json`; the control summary is `cleanup-control64-summary.json`. `summarize.mjs` (SHA-256 `bd2aba51b3d9ff510a7bf1b4935564b2ab4eb9ec27da5dabd89371ce3c73d6b8`) preserves separate query and one-way transport collections. `cleanup-provenance.json` (SHA-256 `04d2f9f9f81dca575e0e320cc2df42bc31932fb177c771455c3143a7ad73edb5`) records package/runtime-source and seven instrumented-source hashes. The earlier `provenance.json`, `5000-first.log`, `5000-second.log` and their summaries are the preserved **pre-cleanup** variant. Additional validation logs include `cleanup-pure-first.log`, `cleanup-typecheck-final.log`, `cleanup-lint-final.log`, `cleanup-format-final.log` and `build-first.log`.

## Upstream coordination and next slice

Both final open profiles, scan summaries, pre-cleanup qualification and exact limitations were sent to **Investigate bounded shared-log state**. Upstream confirmed its pending changes do not modify RPC/pubsub source and supplied no evidence they fix these open cases. Its recommended next split uses scoped timing of public `RPC.open`, `RPC.subscribe` and `pubsub.subscribe`; for the other case, first distinguish client/program, Documents and child-program open intervals. These wrappers would need identical forwarding/error behavior and restoration after measurement. No such wrappers were added in this change. Missing SharedLog-specific fanout spans do not exclude pubsub fanout setup, and internal channel metrics are not a stable consumer API.

For reducing metadata round trips, upstream recommends a bounded study of public `Or` queries for **independent keys within one Documents store and dependency stage**, preserving full branch predicates, explicit source and `replicate:false`. Use explicit bounded pagination and close; ordinary search's default fetch of ten and the number of requested keys are not completeness guarantees. Preserve naming/version/conflict/deletion checks and compatible `canSearch`/`canRead` policies; empty results do not prove authoritative deletion. There is no cross-store/peer atomic snapshot or network-wide freshness guarantee, and no-push does not disable an enabled prefetch accumulator.

The open-phase split and bounded batching study are the next downstream slices. Dependency adoption and unchanged N=3/three-OS acceptance remain separate work; no runtime cache/custody or authority policy was changed here.
