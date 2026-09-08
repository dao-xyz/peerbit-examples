# First full-mode N=3 settlement capture on Peerbit 5.4.5

## Outcome

One first-attempt full-mode capture passed naturally on 2026-09-08:
24 files, 42 chunk puts and 24 metadata puts, an awaited 66-entry persisted
barrier requiring three remote acknowledgements per entry, then four fresh
offline survivors each verifying 42 local chunks and retaining 24 matching
manifests. The test body took 41.12 seconds; the runner took 41.31 seconds.

One chunk put still took **10,069.337 ms**, of which **10,006.973 ms elapsed
before its first settlement callback**. Its observed settlement took only
62.537 ms. This is the strongest new localization: the earlier put stage is
slow, not the observed receipt settlement. It does not identify the responsible
earlier phase, establish a fix, or explain older failures retrospectively.

This was not a retry of a frozen run and there was no adaptive follow-up.
The separate [cohort report](./COHORT_5_4_5_REBASELINE.md) records the installation
and preceding strict local gates. Production release and adaptive acceptance
remain held; one passing sample is not a tail-failure rate or scaling result.

## Exact experiment

Clean measured commit: `108cb1a84da805fb93aaa85e69c265c1cff3d556`, in
`/private/tmp/peerbit-profiled-cohort-20260908`. Node 24.13.1, pnpm 10.26.1,
Darwin arm64. Relevant loaded versions: Peerbit 5.4.5, Documents 15.1.5,
Shared Log 16.0.35, Crypto 3.1.6 and Borsh 6.0.1. The raw report records loaded
module entry-file and package-manifest hashes for all ten worker lifetimes.
Its ten workload/helper source hashes and lock hash were rechecked after
capture and still match.

The topology begins with a publisher and four custodians, adds a fifth
custodian, runs the final write batch concurrently with one custodian's crash,
renews persisted proof, stops the publisher, crashes the four remaining
custodians and opens their
stores in four new offline worker processes. The workload is full replication,
not adaptive placement. All files use 4 KiB chunks; there are 172,032 unique
payload bytes. The original operations, topology, deadlines and teardown were
unchanged from collector head `c65f5eab07ce0f01e480c5a551cd24d664bddb0f`.

Exactly one invocation used the historical diagnostic configuration, not the
strict reporter used by the preceding library/CLI gates:

```sh
env -u CI -u VITEST_IGNORE_UNHANDLED_ERRORS \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=1 \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_MODE=full \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_COPIES=3 \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=1 \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_ENTRY_TIMELINE=1 \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PEER_READINESS=1 \
  PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_SETTLEMENT_PROFILE=1 \
  pnpm --filter @peerbit/shared-fs exec vitest run src/__tests__/adaptive-placement.bench.test.ts --retry=0
```

The process exited naturally with code 0. No blind retries, deadline changes,
forced-success exits, extra readiness probes or dependency patches were used.
The failure-only peer-readiness hook was enabled but did not run. Upstream
deferred heavy same-host work during the window, but unrelated host CPU activity
was observed. This is not an isolated or matched performance comparison.
Synchronous profiling and the larger captured replies also have observer cost.

## Two distinct latency observations

Times below use the same publisher worker's monotonic clock. Cross-process
driver timestamps are not subtracted from them.

| Operation                                               | Whole put       | Settlement duration | Put invocation to first callback |
| ------------------------------------------------------- | --------------- | ------------------- | -------------------------------- |
| File 16, chunk part 0, during custodian-loss transition | 10,069.337 ms   | 62.537083 ms        | 10,006.972667 ms                 |
| File 0, first metadata put                              | 1,073.976083 ms | 1,063.941792 ms     | 10.255208 ms                     |

### File 16: delay before observed settlement

Publisher generation 1, request 26, timeline sequence 45, chunks trace
`persisted:45`. Document hash:
`2d69a44ef199275de9875d9f133f21d840384f9588072dee93f0bf42352ac609`.
Committed entry:
`zb2rhXo4mG33bMk32uFWVJRJgxXsCj3oiWbg7XiuBHB4pk85d`.

The put starts at 18,761.871875 ms. Its first settlement callback is at
28,768.844542 ms; terminal callback at 28,831.065833 ms; fulfilled put result
at 28,831.208875 ms. Only 0.143042 ms separates terminal and result.
The trace has 40 observed/emitted events and zero upstream drops, one plan,
four candidates and a round-1 quorum-validated terminal for `minAcks: 3` and
leader degree 3.

Maximum completed peer-phase durations are confirmation 0.611250 ms,
transfer admission 51.176375 ms, receipt egress 0.037125 ms and receipt request
9.479916 ms. They overlap and must not be summed. Four receipt requests start;
three complete before successful terminal closure. A later completion is not
required to be emitted after the profiler closes.

The enclosing four-chunk file receipt takes 10,260.186416 ms; the metadata
receipt aggregate takes 66.736083 ms (its narrower put is 66.729083 ms).
The earlier append/initial dissemination/queue boundary is the
next upstream investigation, not a demonstrated diagnosis. Local storage,
network dissemination or a specific timeout cannot yet be named as the cause.

### First metadata: confirmation delay inside settlement

Publisher request 2, timeline sequence 5, metadata trace `persisted:5`,
manifest `/file-0.bin`; committed entry
`zb2rhnmKGSkTSiw2s5TihcGMfbAWawtJXoJ3H7iDhLZZzqdzw`.
The put starts at 8,081.958125 ms, first callback arrives at 8,092.213333 ms,
terminal at 9,155.800375 ms and result at 9,155.934208 ms.

All 32 emitted callbacks are captured, with zero upstream drops and a round-1
quorum-validated terminal. The longest confirmation is 1,006.256 ms, transfer
admission 50.271125 ms, receipt egress 0.033083 ms and receipt request
7.126459 ms. This is a separate, mostly confirmation-region delay; it should
not be conflated with the file-16 pre-settlement stall.

Across this small sample, chunk-put minimum/median/maximum are
60.562916 / 64.963313 / 10,069.337 ms (42 puts). Metadata-put values are
60.703416 / 66.871938 / 1,073.976083 ms (24 puts). These are descriptive fixture
statistics, not p95/p99 estimates, throughput results or speedup claims.

## Durability and cleanup evidence

All 66 per-entry puts fulfilled. The final renewed barrier covers 42 chunk
entries and 24 metadata entries, actually awaits three persisted remote
acknowledgements per entry, and completes in 46.544542 ms. Profile callbacks
alone are not the durability proof.

After publisher shutdown and the planned custodian crashes, offline peers 2–5
(generations 7–10) each have 42 locally verified chunks, 24 manifests matching
their pre-crash fields, the same identity, zero connections and no advertised
listening addresses. Every chunk has four verified surviving copies; no
metadata is missing. This checks chunk bytes and manifest fields, **not 24
reconstructed whole-file reads in the offline processes**. Earlier eight hot
reads passed with zero local misses and zero remote returns, so they do not
establish sparse remote-fetch behavior either.

Ten worker lifetimes have exactly one recorded exit each: publisher and four
offline reopen workers each fulfill their sole `peer.stop` and exit 0; five
online custodians exit via the intended SIGKILL crash scenarios. There are no
scenario failures, stop/tail diagnostic omissions or worker first failures.
At 10:19:48 UTC all ten owned PIDs were absent:
41304, 41307, 41312, 41320, 41321, 41329, 41418, 41419, 41421 and 41427.
No unrelated process was terminated. Retained stores remain at
`/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-full-8lm7Xf`.
No physical block reclamation was tested or performed.

## Profile reconciliation and limitations

Two independent read-only analyses and a separate raw review reconcile 74
snapshots containing 260 trace copies and 11,064 event copies into **68 unique
traces and 2,984 unique callbacks**: 42 chunk puts, 24 metadata puts and two
barriers. Every trace has exactly one quorum-validated terminal, and each
terminal's emitted count equals the captured callback union for that trace.
Per-plane sequences are contiguous: chunks 1–1,879, metadata 1–1,105.

There are no upstream dropped events, invalid observations, capacity losses,
late-after-terminal arrivals, conflicts, unknown-version failures or counter
saturation. Normal bounded-window evictions occurred: chunks 35 traces /
1,439 events; metadata 17 traces / 618 events. Success replies recover those
earlier observations in the merged union; evictions left no callback gaps in
this capture. Cumulative counter maxima are used, not sums over snapshots.

This completeness concerns emitted callbacks, not every internal operation or
entry. The two barriers detail only the first 16 entry ordinals, leaving 26
chunk entries and eight metadata entries outside that sample. Under the exact
installed contract, profiling closes before terminal dispatch, suppressing
later asynchronous phase completions. An unmatched start is not by itself a
lost callback or failed request. Progress counts may decrease after validation;
entry ordinals are not CIDs; phases overlap.

Trace correlation relies on the harness's sequential operations and the
synchronous terminal-before-awaited-return contract, independently rechecked
against the installed release. Run identity is
`2700e83c511da9bcfd62fab35326f00cb4e6350896e7c02f4fead08307327cdc`;
the publisher observer is `7nO3BAtnrB0dAVkuEpmB66CoGy2VZgPHL898/J5mePE=`.
The chunks log is `zb2rhcUWFG3hYvf7c594PjZmtKVeKMjCtp4qWsWuayZ2wZ7qu`,
metadata log `zb2rhfdT1BY19sA9jxjN5s9AxNvBXB4ACBxoV31kR5gvY5xW1`.
Trace IDs alone are not globally unique or wire-level entry identifiers.

The settlement analyzer's detailed section selects slow settlements, not slow
enclosing puts. File 16's fast settlement therefore required direct raw event
inspection alongside the entry timeline. Its omission from that detailed
section is not an omitted trace. No analyzer mismatch was found.

## Frozen artifacts and next boundary

Local artifact prefix: `/private/tmp/peerbit-profiled-cohort-20260908-`.

| Suffix                           | Bytes      | SHA-256                                                            |
| -------------------------------- | ---------- | ------------------------------------------------------------------ |
| `n3-full-first.raw.log`          | 13,246,040 | `bfe8ab2dc9f47fe112bb7fd2e84d5e962c67c3a082e7b958538d22cd86829045` |
| `timeline-first.analysis.json`   | 96,270     | `8e00835190b6836efa9290c1a488d4ba3713c4aabb8063b746fcc953ebd70d3e` |
| `settlement-first.analysis.json` | 231,658    | `0b133ba7ab7b1b0d554fcfa2235c746681f9566a36d35a97281905e1cf9cd575` |

Lock SHA-256:
`eb738d37a9b874992038694a7a388b6ec7570f203d6e7d2299b12eb4c1ace86f`.
Read-only settlement analyzer: the same prefix plus `analyze.mjs`, SHA-256
`f9fa80e4c7f2380cc30c2db125feb952bd5608fc419a5d4f553ae7cc44482628`.
Companion timeline analyzer:
`/private/tmp/peerbit-n3-entry-timeline-20260908-analyze.mjs`, SHA-256
`bd2a114125fc0642a8bdd331553e16681e49b6a1d8065522a9c92cfbd557eb52`.
The new analyzer was checked on bounded positive synthetic observations and
the older negative raw before this capture; it does not import Peerbit, run
children, send traffic or alter retained stores.

The frozen [5.4.4 first failures](./ADAPTIVE_SHARDING_5_4_4_RESULTS.md),
[separate passing diagnostic](./N3_PEER_READINESS_DIAGNOSTIC_2026_09_07.md)
and [targeted fourth-chunk failure](./N3_ENTRY_TIMELINE_CAPTURE_2026_09_08.md)
remain independent evidence. Today's pass does not prove the routing release
fixed their causes. No deadlines or failure records were replaced.

The upstream task **Investigate bounded shared-log state** received the exact
file-16 timings, entry hash, raw path/hash and measured commit, and accepted a
bounded investigation of the pre-settlement boundary. It requested no further
downstream run or new probe yet. Its separate metadata-confirmation case
remains distinct. Next downstream acceptance is fresh three-OS strict evidence;
adaptive resilience, large sparse opens, bounded storage and multiplayer mount
behavior still require their own checks. No merge/release or scalable-FS claim
follows from this small full-replication capture.
