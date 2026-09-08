# Bounded persisted-delivery settlement diagnostics

This prepares a test-only downstream collector, not a receipt fix, dependency
upgrade or new performance result. The exact source contract is upstream
[PR #1457 at `0e9e351`](https://github.com/dao-xyz/peerbit/pull/1457/commits/0e9e351b4a9aee4128ff11ad363e0958774d544c),
verified draft and unpublished when this work began. During preparation it
merged as `dc07773ad91ae3f463152de810e3a83f187aa4c6` with that same reviewed head.
Upstream confirms the regenerated release proposal is being checked; no new
coherent cohort has been published or handed off yet. The installed coherent
5.4.4 cohort does not emit these new events. No event therefore means
**unobserved**, not zero work, success, failure or a negotiated unsupported status.

The frozen [targeted first failure](./N3_ENTRY_TIMELINE_CAPTURE_2026_09_08.md)
remains a locally committed fourth chunk followed by a 20-second N=3 receipt
timeout. Peer-only readiness observed after rejection could not identify the
missing settlement phase. This collector prepares that missing evidence;
neither the separate passing sample nor upstream routing work proves the cause.

## Collection and bounds

`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_SETTLEMENT_PROFILE=1` requires
`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=1`. It adds publisher-only sinks
for metadata and chunks to the existing `Documents.open` profile callbacks.
Neither flag enables the separately opt-in live workload. The collector uses no
upstream runtime imports and shares the existing own-data descriptor reader.

Only the five `sharedLog.persistedDelivery.*` families (`plan`, `candidate`,
`peerPhase`, `progress`, `settle`) with `component: "shared-log"` and `details.v: 1`
are accepted. Fixed scalar whitelists omit payloads, keys, session objects,
unknown fields and top-level `count` (not emitted by this contract). Optional
missing fields stay missing; a fulfilled request with `acceptedEntries: 0` is
valid. Unknown versions, invalid observations and omissions have explicit
counters. Arbitrary property accessors are not invoked.
Counters saturate at `Number.MAX_SAFE_INTEGER` with a sticky `saturated` flag;
arrival-sequence uniqueness is no longer guaranteed after saturation. Counters
are diagnostic categories, not a disjoint event partition.

Each plane retains at most eight traces, with up to 256 detail records and a
separate reserved terminal record per trace. A new trace evicts the oldest
completed retained trace; incomplete traces are never evicted. If all eight are
incomplete, incoming unknown-trace events are dropped and counted, including a
separate terminal-capacity omission count. This is a recent diagnostic window,
not complete history. A reappearing evicted trace ID cannot prove earlier
coverage. Later events for a retained terminal trace are counted, not appended.

Trace identity is scoped by hashed run ID, peer number, worker generation,
observer public-key hash, plane and bound log address. Raw trace IDs are only
process/module-local upstream counters, not wire IDs or committed-entry IDs.
Matching receipt events before log binding are explicitly counted and omitted.
Per-record sequence is collector arrival order, not protocol causality.

Before each original persisted put or barrier, the worker supplies a detached
caller-owned label: request number, operation kind, and file/chunk part when
applicable. The first label is preserved; conflicting later labels are counted,
not used to rewrite attribution. The existing per-entry timeline supplies the
document/committed-entry context; no CID is inferred from `entryIndex`.
This label describes the operation active at synchronous callback dispatch, not
an upstream trace-to-entry assertion. Correlation relies on this harness's
sequential persisted operations and the exact upstream revision dispatching its
terminal in settlement's `finally` before the awaited operation settles, closing
the profiler before terminal dispatch and suppressing later detail callbacks.
Terminal-only traces are valid under those guarantees. Recheck this basis when
adopting the released schema; a deferred callback could invalidate attribution.
Successful replies include only retained traces for that request, explicitly
labelled `traceFilter`; counters still cover the whole worker/log lifetime.
Existing failure and unqueued profile checkpoints expose the full bounded
snapshot, including incomplete traces. Snapshots are detached and cumulative;
do not add duplicated events from repeated snapshots.

## Interpretation and observer cost

Settlement starts after local commit, not at put invocation. `durationMs` for
`peerPhase` is phase elapsed time; other families use elapsed settlement time.
`details.elapsedMs` is settlement-relative for every family. These overlapping
durations cannot be summed into a critical path. Collector receipt timestamps
use the writer's monotonic clock, not a cross-process clock mapping.

Candidate events may precede plans. Transfer-admission phases may repeat without
an attempt number; attempt numbers are receipt chunk ordinals, not retry counts.
Provisional carried acknowledgments can decrease after session revalidation.
The first-16 entry sample window is not measured coverage, and phase counts can
include work outside that window. A missing terminal or phase end is unknown,
including when the process dies or work finishes after the terminal closes.

Upstream terminal `emittedEvents` counts callback dispatches, not successful
downstream retention. Its `droppedEvents` counts only upstream detail-cap
suppression, separately from the collector's omissions and unsampled entries.
Neither progress nor a captured terminal replaces the awaited persisted put or
delivery result as the actual durability proof before source disposal.

The original puts, entry accesses, delivery options, command ownership, failure
propagation, topology, deadlines and teardown remain unchanged. There is no new
waiter, planning/readiness probe, promise, timer, listener, delivery call, retry
or diagnostic IPC round trip on the operation path. Synchronous scalar parsing,
bounded allocations, snapshot copies and larger existing replies still add
observer work; no zero-overhead or unchanged-scheduling claim is made.
All implementation changes are in excluded test sources. Production package
source, dependency declarations and the lockfile remain unchanged.

## Validation and release gate

Worktree: `/private/tmp/peerbit-settlement-profile-20260908`, based on
`cd9f1b5b31ad7fadd7062b423c40f0fa6316fdf4`. Dependency directories reuse the
existing coherent 5.4.4 install; no installation or dedupe was performed.
Local validation uses synthetic exact-schema fixtures with the live workload
explicitly disabled and retries zero. The first helper run passed 44 cases;
namespace and barrier-label review added two cases before the first combined
run, which passed 150 tests with two live scenarios skipped. Strict TypeScript
and ESLint passed. Review then added exact zero-acceptance and worst-case bounded
serialization coverage. The final combined run passed **152 tests**, including
**48 settlement collector cases**, with the same two live scenarios skipped.
Final strict TypeScript and ESLint checks also passed. Independent source/schema
and worker-integration reviews found no remaining blocker. These are historical
Vitest configuration results with `--retry=0`, not strict-reporter gate counts.
The first formatting check flagged only the newly added report table; it was
formatted without code changes, and that original check log is retained.

The unchanged lockfile SHA-256 is
`dfa07c924f7a9bd49ccc53d6f81b47747f0de0b41ddfb4a409d324d4e7522752`.
The prior targeted failure raw log still hashes to
`93a57a6bc80bb79e55d19efafb8f5d63ee3d90c272cb7b7063f58dee1f8f011b`.
The original user checkout and its untracked `native.test` remain untouched.
No live workload was launched, so these checks do not establish real transport
capture, a receipt-liveness fix or performance improvement.

Raw logs share `/private/tmp/peerbit-settlement-profile-20260908-`:

| Suffix                                          | Outcome                        | SHA-256                                                            |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `helper-first.raw.log`                          | 44 helper cases passed         | `92841dd53ed07a44a5380e7050b9e702d85717837896caae39dccd9232666633` |
| `focused-first.raw.log`                         | 150 passed, 2 live skipped     | `3a9f3dcef0d0a38dd6a6f720124f51e2a2222195c2cf085bd542af418a3b77ea` |
| `typecheck-first.raw.log`, `lint-first.raw.log` | Both exit 0, empty             | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `focused-final.raw.log`                         | 152 passed, 2 live skipped     | `caebd70f170a3d42456250ebbe97e4676f5dcbeab8e5e4a12c84b38db273a9c3` |
| `typecheck-final.raw.log`, `lint-final.raw.log` | Both exit 0, empty             | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `format-first.raw.log`                          | Report table needed formatting | `22bf72a11fb6ec78cb71e9ebfee70e198181e8d3a033924e8c8f206e368c6b94` |

Before a real capture, upstream must provide a published, verified coherent
cohort containing the intended fixes and profile schema. Recheck the final
contract, then pin that cohort with one plain install, run the existing strict
gates and perform a separately labelled first-attempt targeted capture. Preserve
every original failure and stop at the first failure; no adaptive follow-up or
broader release clearance is implied. The downstream release gate remains held.

## Integrated checkout prepared for the release handoff

The next user-authorized upgrade/capture has an isolated checkout at
`/private/tmp/peerbit-profiled-cohort-20260908`, branch
`upgrade/shared-fs-profiled-cohort-20260908`. Bot-authored merge
`968b589d083958932edcd98cce25e9fc5a070871` combines the held cohort/strict-gate
head `8610b1a043667dfda9573914723c1620bbd55972` with collector head
`c65f5eab07ce0f01e480c5a551cd24d664bddb0f`; neither original branch was changed.

The only overlapping paths were the library manifest and lockfile, already
byte-identical at both heads. The merge required no conflict resolution. All ten
placement workload/helper sources and the lockfile remain identical to the
collector head. Production library/CLI entry sources, strict runner/reporter and
portable workflow remain identical to the held cohort head. This matters because
the separate collector checkout did not itself contain the strict CI harness.

The new checkout has not installed dependencies or run any workload. Run its own
`scripts/shared-fs-strict-tests/vitest.config.mjs`, not a cross-worktree wrapper,
for the full library/CLI gates after the verified pins arrive. Historical test
counts are expectations only until those gates execute. The exact upstream
version candidate is merged as `32c8889257dfcc01b94eafb06c030591719fd895`, but
[publisher run 34210235918](https://github.com/dao-xyz/peerbit/actions/runs/34210235918)
is still pending at this preparation checkpoint. Upstream explicitly requires
publisher success followed by registry/tag/consumer verification before handing
off the cohort; no proposed package versions have been adopted.
