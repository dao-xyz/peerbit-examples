# Split-plane N=3 placement and profiling — 2026-09-05

## Outcome

**Full replication passed; adaptive placement failed its joined-peer stability
gate and then a shutdown deadline.** Both were sequential, first-attempt runs on
the released Peerbit 5.4.1 cohort. This extends the [successful N=2
rebaseline](ADAPTIVE_SHARDING_REBASELINE.md); it does not replace its results or
establish a production sharded filesystem.

The experiment now supports explicit N=2 or N=3 persisted acknowledgements and
independent metadata/content profiling. Default N=2 behavior remains available.
No production replication setting, filesystem format, dependency pin or lockfile
changed relative to the rebaseline branch. No merge or release is authorized by
these results.

For N=3 the topology is one publisher plus 4 → 5 → 4 custodians. Custodian 5 joins
while the publisher continues writing; custodian 1 is later killed if the join
gate passes. The same fixture contains 24 files and 42 distinct 4 KiB chunks
(172,032 logical payload bytes). Soft custodian log-byte targets are 75,264,
129,024, 182,784, 258,048 and 322,560 bytes. These are not hard quotas or different
physical machines.

| Check                                              | Full                          | Adaptive                  |
| -------------------------------------------------- | ----------------------------- | ------------------------- |
| Successful chunk-first and metadata receipt writes | 24                            | 16 before failure         |
| Joined-peer inventory stability gate               | passed                        | failed at 30 s            |
| Final exact-entry receipt renewal                  | 42 chunks + 24 manifests, N=3 | not reached               |
| Offline verified chunks on survivors 2 / 3 / 4 / 5 | 42 / 42 / 42 / 42             | not reached               |
| Offline complete manifests on each survivor        | 24                            | not reached               |
| Every normal stop completed naturally              | yes                           | no: custodian 5 timed out |

Full mode stopped the publisher, abruptly killed all four remaining custodians,
and reopened each in a fresh process using the same identity and state directory
with no listening addresses or connections. Every locally indexed chunk was
loaded and verified by length/hash; manifest coverage was checked independently.
The source directory was retained but not used for recovery. No physical block
reclamation or source-directory deletion was tested. All 16 worker PIDs across
the two runs were subsequently confirmed gone; forced termination after the
adaptive cleanup timeout remains a failure, not a successful stop.

## Timing and the failed gate

| Observation                                          | Full         | Adaptive    |
| ---------------------------------------------------- | ------------ | ----------- |
| Median receipt latency, first 16 files               | 132.57 ms    | 134.94 ms   |
| Slowest receipt, first 16 files                      | 4,594.15 ms  | 6,508.24 ms |
| Median receipt latency, all 24 files                 | 129.77 ms    | not reached |
| First receipt after planned custodian loss (file 16) | 21,294.53 ms | not reached |

Medians average the middle two sorted observations. These are descriptions of
one run per mode, not an overhead/speedup estimate. The 21.3-second full-control
outlier was launched concurrently with the planned custodian loss and completed
after the crash. It comprises 21,233.38 ms of sequential chunk receipts and 61.14 ms for its
manifest. It succeeded under the unchanged 25-second whole-command budget, but
is a significant failure-time responsiveness concern. No retry was used.

The full final exact-entry renewal took 52.27 ms. Test-body durations were
59.43 seconds full and 71.52 seconds adaptive (including its failed cleanup).
Those totals include process startup and artificial settling gates; their ratio
is not filesystem throughput.

Adaptive mode stopped after 16 acknowledged files (28 chunks). The failure was
`joined-custodians: coverage/metadata/inventory-stability deadline` at 51,459.33 ms
from scenario start. The last samples had complete metadata and at least three
custodian copies per chunk, but content inventories were still changing. This
is **not a persisted-receipt failure or demonstrated data loss**. Sampling does
not prove uninterrupted coverage between observations. Budget reduction,
planned custodian loss, later writes, remote reads, final receipt renewal and
offline recovery were not reached in this mode.

Every one of the adaptive joined phase's 28 samples met N=3 content coverage.
The joiner's metadata was incomplete only in the first two samples (21.260 and
22.268 seconds); all manifests were present from 23.276 seconds onward. Content
inventories changed in 24 of 27 adjacent comparisons. The maximum consecutive
unchanged complete comparisons was one; the unchanged gate requires two. Final
regular-sample custodian chunk counts (50.454 seconds) were
17 / 26 / 20 / 27 / 17, each with all 16 manifests. The later failure inventory
(51.469 seconds) was 17 / 27 / 20 / 25 / 15, showing continued movement.
Thus the deadline does not mean users lacked metadata for 30 seconds, nor does
it demonstrate unsafe custody. It demonstrates continued residency movement.
The full joined phase had complete metadata by 22.060 seconds and passed the
same stability gate at 24.081 seconds.

Failure inventories and a separate cheap profile snapshot were captured before
cleanup. Custodian 5 then exceeded the unchanged 20,000 ms stop acknowledgement
deadline at 71,473.09 ms. The original failure and cleanup failure are both
preserved in the raw report; there was no retry, deadline increase, disabled
transport or forced-success exit.

## Profiling contract

`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=1` attaches a cheap `sync.profile`
callback separately to the two `Documents.open` calls. Each snapshot includes
peer identity, process generation and each plane's log address. Aggregates retain
only event names, counts, timed counts, duration sums/maxima and invalid/dropped
counters—not upstream event objects or payloads. Bounds are 128 distinct names,
96 characters per name and saturating numeric counters. Disabled profiling
installs no callback.

The failure path preserves bounded nested error causes, commit/retry-safety
flags and committed/failed identifier lists. A profile-only command bypasses the
worker's asynchronous store-command queue, so a stalled inventory request need
not hide already-recorded counters. It does not override a blocked JavaScript
event loop. Late command errors remain in the first-failure record even after
their parent request has expired.

Snapshots are cumulative within one process generation. Use only the latest
online snapshot per `(peer, generation, plane)` for an online summary; never add
successive cumulative snapshots or substitute the later offline-open counters.
Durations may overlap and nest: sums are not CPU time, wire cost or a wall-clock
critical path. Upstream's newer adaptive tick/idle-deferral events were not
released in this cohort. Its identified post-append idle deferral is a source
lead, not measured attribution for this failure.

Latest-online aggregates emitted 1,949 metadata / 3,389 chunk events in full
mode and 1,408 / 13,425 in adaptive mode. Every captured plane/process had zero
invalid or dropped events and no counter saturation (13–34 distinct names).
Runs differ in length and reached phases, so these counts are not normalized
workload comparisons.

| Chunk-plane event                | Full count / max span | Adaptive count / max span |
| -------------------------------- | --------------------- | ------------------------- |
| `sharedLog.receive.joinPlan`     | 178 / 1.75 ms         | 449 / 20,284.67 ms        |
| `sharedLog.receive.checkedPrune` | 178 / 3.15 ms         | 382 / 31.80 ms            |
| `sharedLog.receive.lowerLogJoin` | 178 / 268.03 ms       | 382 / 501.41 ms           |

The adaptive join-plan maximum belongs to peer 3, generation 4. Its many
overlapping elapsed spans are a useful upstream investigation target, not proof
that this stage consumed 20 seconds of CPU. Metadata join-plan maxima remained
below 0.52 ms. Approximately 30-second `simple.onMaybeMissingEntries` spans occur
in **both** modes; they alone cannot explain why the adaptive gate failed.

## Reproduction and provenance

From a checkout with the coherent release installed, load the bot environment
and run these separately and sequentially, changing only `MODE` from `full` to
`adaptive` (the actual environment variable is shown below):

```sh
source .envrc
PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=1 \
PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_MODE=full \
PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_COPIES=3 \
PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=1 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/adaptive-placement.bench.test.ts --retry=0
```

This worktree reused ignored dependency links to the previous fresh installation;
no install, dedupe, override or node_modules source patch was performed for this
campaign. Core worker resolutions were independently emitted and checked in
every process. Cohort: peerbit 5.4.1, document 15.0.32, shared-log 16.0.29,
program 6.0.59, trusted-network 6.0.130, pubsub 5.4.5, blocks 4.3.0,
blocks-interface 2.2.0, crypto 3.1.6, Borsh 6.0.1. The known duplicate runtime
interface-import concern remains; upstream PR #1435 is not installed here.

Host: macOS 26.6.2 (25G83), arm64 Apple M3 Pro, 36 GiB RAM; Node 24.13.1 and
pnpm 10.26.1. All processes share host/disk; other app work may coexist. Keys
and placement are independently randomized between modes. These small runs do
not establish throughput scaling, reliable tail percentiles, profiling overhead,
capacity fairness or superiority to another filesystem.

Raw logs are retained under `/private/tmp/peerbit-performance-20260905/`:

| File                                         | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `adaptive-n3-profile-full-first.raw.log`     | `e69256cc559db0807faa336c6260cedc0dc94b90b9d2a624dd4d7d0d7626e351` |
| `adaptive-n3-profile-adaptive-first.raw.log` | `521d1a146a7433b43b396aa8bac1632df6ea39c61553cdaa51ce4df40d57e544` |

Both reports record identical frozen source hashes (paths relative to
`packages/shared-fs/library/src/__tests__`, except the lockfile):

| File                                 | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `adaptive-placement.bench.test.ts`   | `10970d21b5c1d01d7f60dcbe126d0151dcb772faee3e3a4096811ea68c472f31` |
| `adaptive-placement.bench.worker.ts` | `f1f5db01eaf7ccdd844616734a186520501a8f90952f8f8c9dc9ab98d2809990` |
| `adaptive-placement.bench.model.ts`  | `f03393093e2c8f893e06a61a688bd6b1e8d67518763fe4db54541a456a505de0` |
| `adaptive-placement-analysis.ts`     | `9c32d7da884af246dabe21c0f4d8e37ed93c45b7fe9e142ae1f80be5c0213dfe` |
| `adaptive-placement-telemetry.ts`    | `ce0819a3b5a0d7cc1206ead2ce7dc580acb8c470ddc684412434e19a32374acf` |
| `process-isolated-soak-storage.ts`   | `f3fcbab4d9317b7d9c8952feba3d522fe8b436411767e592ac5fd53402d3592e` |
| root `pnpm-lock.yaml`                | `837a6d0b14aa703ed9165ffeaf40e55d1630cc398c55a754bb39dcb7706dbd85` |

Retained state directories:

- Full: `/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-full-5yqhmj`
- Adaptive: `/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-adaptive-3gVYUs`

## Validation and next gate

The 28 analysis/topology/telemetry unit tests pass, including default N=2 plan
compatibility, N=3 bounds, diagnostic memory limits and nested-error preservation.
Standalone strict TypeScript, explicit lint and formatting pass. Library and CLI
builds and package-content checks pass; all benchmark/profile helpers remain
excluded. This is not a full latest-cohort filesystem suite or cross-OS campaign.

CLI unit tests also pass (33). Full mode's eight verified hot reads had zero
local misses and zero remote returns: unlike the earlier N=2 adaptive run,
this campaign has no completed remote cache-miss-read demonstration.

Validation setup failures were retained: an invocation with strict null checking
but `noImplicitAny=false` inferred existing empty scratch arrays as `never[]`;
the normal strict invocation passes. The initially absent CLI workspace link
prevented its build/pack check; an ignored link to this worktree's library fixed
that without an install or changing measured worker dependencies. Neither was a
live-protocol rerun.

Upstream was contacted directly with the prior N=2 results and these N=3 raw
failures. Wait for its verified release/profile contract before a new labeled
rebaseline. Keep N=3 adaptive placement experimental. Required next evidence is
bounded join settling, failure-time write latency, clean shutdown, and then a
complete adaptive N=3 crash/offline run. Production integration also needs
namespace semantics, authorized writers/revocation, actual transfer metrics,
mounted workloads and heterogeneous failure domains.
