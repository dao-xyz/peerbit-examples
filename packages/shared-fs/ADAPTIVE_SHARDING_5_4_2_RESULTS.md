# N=3 released-cohort rebaseline — Peerbit 5.4.2

Both first-attempt modes are **red**, for different reasons. Full replication
failed a persisted receipt during peer join. Adaptive placement failed joined
inventory stability and then program-handler shutdown. No assertion, transport,
authorization, workload or deadline was changed, and neither run was retried.
These are new-cohort results, not replacements for the preserved
[5.4.1 observations](ADAPTIVE_SHARDING_N3_PROFILE.md).

## Scope and provenance

The unchanged [bounded diagnostic harness](ADAPTIVE_SHARDING_DIAGNOSTICS.md)
comes from `7b2ce8fd5106ab6b2cc8057a8c08f0b4404e27d9`. Only package pins and lock
changed before execution. This is a test-only split-plane Documents model, not
a production sharded filesystem. The planned topology remains one publisher
and 4 → 5 → 4 custodians, 24 files / 42 unique 4 KiB chunks, with N=3 persisted
receipts and heterogeneous **soft log-byte targets**, not hard quotas.

The release publisher succeeded at `58bb9e09ab6cb41d484e37657e0369c68cc3a06b`.
Downstream independently verified all 26 npm manifests/dependency anchors and
26 tags. One plain pnpm install was performed in the separate production
integration checkout; ignored dependency links reuse that same installation
here. No second install, dedupe, override or dependency-source patch occurred.
All workers report Peerbit 5.4.2, document 15.1.0, shared-log 16.0.30, crypto
3.1.6 and Borsh 6.0.1. Node v24.13.1, pnpm 10.26.1, Darwin arm64, same host.

- Lock SHA256: `f5c3a197949daccb71ae4fd2585704287d025c83499b2d84d5e0f5b255f924b9`.
- Harness SHA256: `2b774c8422de1ff99fd3ffdaa6e6df487784c967cd62e1e75c6886aa75424947`.
- Worker SHA256: `d2d7904e48ee76b90cb62876b41ed04986f362d45917309cc2e44b401ed365e2`.
- All 49 diagnostic unit cases passed before live execution.

Full and adaptive were run separately and sequentially with
`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=1`, mode `full` then `adaptive`,
`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_COPIES=3`, profile `1`, and Vitest
`--retry=0`. No other local suites ran during the live measurements.

## Results

| Observation                                         | Full                      | Adaptive                        |
| --------------------------------------------------- | ------------------------- | ------------------------------- |
| Acknowledged files before failure                   | 12                        | 16                              |
| Median successful file receipt                      | 128.11 ms                 | 127.14 ms                       |
| Slowest successful file receipt (file 0)            | 4,986.57 ms               | 5,811.10 ms                     |
| First failure                                       | N=3 chunk receipt timeout | joined inventory stability      |
| Failure time from scenario start                    | 35,908.85 ms              | 51,408.43 ms                    |
| Normal worker OS exits                              | 6 of 6                    | 5 of 6                          |
| Failed shutdown                                     | none                      | peer 4, 20-second stop deadline |
| Planned loss, final receipt renewal, offline reopen | not reached               | not reached                     |

Successful-write medians exclude the failed full-mode write; they do not
estimate failure-inclusive latency, p95/p99, throughput or a speedup. Scenario
durations (39.05 and 71.48 seconds) include setup, artificial settling gates and
cleanup and must not be compared as throughput.

### Full: receipt liveness failure during join

Peer 5 connection began at 15,622.49 ms and completed at 16,143.08 ms. The next
file's chunk write reached `Documents.put` at worker line 275 and threw
`PersistedDeliveryError`: local commit succeeded, but the required three valid
persisted remote receipts were not obtained within the unchanged 20-second limit.
The exact committed log hash is
`zb2rhcuiEqLrWi9vYVQ6pmxigGD7ZmA8CC9T6sMTpL1Sz2PwD`.
`localCommitSucceeded` is true and `retrySafe` is false; no retry was attempted.
The shared 25-second whole-write cancellation budget was unchanged.

Failure inventories show 24 chunk IDs and 12 manifests on every peer. Those
observations have `verifiedLocalChunks: null`; they are not receipt evidence or
offline byte verification, and the failed entry hash is not a content ID.
The current trace does not capture historical per-candidate receipt counts or
which confirmation/barrier response was missing. Do not infer data loss, a
specific missing leader, or safe source disposal from these inventories.

Completed chunk join-plan spans had a maximum of 1.268 ms and zero retained
spans at least one second. This differs from the adaptive long join-plan
signature; it does not rule out uncaptured/in-flight work. All six workers
subsequently completed real stop and natural OS exit with code 0.

### Adaptive: coverage observed, inventory never settles

All 30 joined-phase samples had at least three custodian copies of each of the
28 acknowledged chunks. Metadata was incomplete only in the first two samples;
all 16 manifests were visible from 22,964.39 ms. Inventories changed in 25 of
29 adjacent comparisons; the maximum was one unchanged complete interval,
below the existing two-interval stability gate. Final regular custodian counts
were 17 / 28 / 25 / 16 / 20 chunks, with all 16 manifests each.

Thus the failure is continuing residency movement, not a demonstrated receipt
failure or data loss. Samples do not prove uninterrupted coverage or physical
durability. Budget reduction, planned loss, missing-local-content reads, final
receipt renewal and offline recovery were not reached.

Latest pre-cleanup profiles include 472 chunk join-plan spans with maximum
20,011.43 ms on peer 4. Its largest retained span had one entry, zero immediate
replicating-leader-plan hits, one plan, and both native fast-path flags false.
Other custodians also retained slow spans. This supports investigating entry
leader eligibility waits, not a causal conclusion about the stability or stop
failure. New profile aggregates record 1,193 chunk placement passes (max
34.87 ms), 226 adaptive rebalances (max 91.97 ms), and 2,031 repair dispatches
(max 30,000.81 ms). These spans overlap/nest and cover different reached phases
and run durations; sums are not CPU time or a critical path.

No aggregate profile events were invalid/dropped or saturated. The slow-span
retention is intentionally bounded to eight per plane/worker; its eviction
counts are not missing aggregate events, and retained samples are tail-biased.

### Adaptive shutdown is now localized

Peer 4, generation 5, stop request 40 was received and dequeued immediately.
On its worker-relative clock, bootstrap recovery fulfilled at 0.405 ms and
`peer.handler.stop` entered at 0.412 ms. Both parent observations and independent
worker checkpoint replies at 5,001.82 ms and 19,002.75 ms showed only
`peer.stop` and `peer.handler.stop` pending, with no omitted worker events.

No storage-close, indexer-stop, libp2p-stop, disk-scan or stop-reply stage was
entered before the unchanged 20,000 ms deadline. This localizes the observed
wait inside handler/program close, not to those later phases; the nested cause
is still unknown. The checkpoint replies also show the worker event loop was
responsive at those times. Failure cleanup killed peer 4 with SIGKILL; this
remains a failed shutdown, never a natural success. The other five exited
naturally with code 0. All 12 PIDs across both runs were independently confirmed
gone. State directories remain preserved; no physical reclamation was tested.

## Evidence and follow-up

Raw logs under `/private/tmp/peerbit-performance-20260905/`:

- `cohort-5.4.2-n3-full-first.raw.log`, SHA256
  `6893638d62cd2553453ea14d7f02d2a038c56a9584368adbf2b34aa9d8874961`.
- `cohort-5.4.2-n3-adaptive-first.raw.log`, SHA256
  `e6d9c64f2def1d9deda1a747136dc79c59231b11d2cf6b65ec09b9d8b9395d25`.
- `analyze-cohort-5.4.2-n3.mjs` and `cohort-5.4.2-n3-summary.json.log`
  preserve the extraction method and compact results. The raw reports contain
  exact identities, module-entry hashes, snapshots, errors and shutdown traces.

Both first failures were delivered directly to the upstream task, which is
investigating receipt liveness and program-close waits separately. A future
bounded diagnostic may add post-failure, exact-entry candidate readiness
snapshots; such snapshots must be labelled advisory and cannot reconstruct
historical receipt counts or establish disposal safety. Wait for the reviewed
instrumentation seam; do not call recovery waiters or rerun unchanged tests
merely to obtain green results.

The separate [production cohort integration PR #346](https://github.com/dao-xyz/peerbit-examples/pull/346)
passed local strict library/CLI tests (540 + 33, zero retries) and import-time
class-identity checks. Its fresh three-OS matrix also passed at exact head
`b8e88833f51535e886236ec41ea55ffb29a8316c`, first workflow attempt: each OS had
540 library passes / 10 skips and 33 CLI passes, zero retries and no missing
strict instrumentation. Raw logs contain no first-failure or hanging-exit
markers. All three-OS package-install and cross-OS interop jobs passed too.
Portable run: [33978584109](https://github.com/dao-xyz/peerbit-examples/actions/runs/33978584109).
Those results do not clear either experimental N=3 failure. No merge or release
is implied; the integration remains draft pending those investigations.
