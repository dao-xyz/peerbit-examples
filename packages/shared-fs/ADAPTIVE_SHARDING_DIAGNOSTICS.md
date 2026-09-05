# Bounded placement and shutdown diagnostics

This is a test-only follow-up to the [N=3 first-attempt results](ADAPTIVE_SHARDING_N3_PROFILE.md).
Those measurements belong to commit `15f40b98d0c054a11e768837c95bbc5f201d007c`.
The diagnostic additions below have not rerun or cleared either failed N=3 gate.
They do not change production shared-fs, controller policy, dependencies,
transports, receipts, or the experiment's deadlines.

## Slow join-plan evidence

With `PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=1`, each plane's profile now
includes `slowJoinPlan`. It retains the eight slowest valid
`sharedLog.receive.joinPlan` spans of at least 1,000 ms, sorted by descending
duration. Equal-duration ties retain earlier samples. Aggregate event counts
and duration maxima still cover all admitted observations.

Each detached sample contains `durationMs` and, only when present and valid:

- Nonnegative safe-integer `entries` and `count`.
- `details.immediateReplicatingLeaderPlanHits` and
  `details.immediateReplicatingLeaderPlans`, also nonnegative safe integers.
- Exact booleans `details.nativeSynchronousJoinPlan` and
  `details.nativeAllKeptJoinPlan`.

No getters, arbitrary details, entry identifiers, payloads or upstream runtime
objects are retained. Missing values remain absent/unknown, not zero or false.
The summary includes `observed`, `dropped` (including evicted samples),
`invalidFields`, `thresholdMs` and `maxSamples`. Samples are contextualized by
the existing peer identity, process generation, metadata/chunk plane and log
address in their enclosing snapshot. Eight slowest samples are deliberately
tail-biased evidence, not a latency distribution or unbiased percentile sample.

The installed shared-log 16.0.29 emits these fields. Its receive path can await
up to 20 seconds for local entry-leader eligibility inside join-plan processing
before lower-log join. This makes a placement/role wait a plausible lead for the
earlier 20.285-second span; **it does not attribute that historical span**. The
old aggregate-only logs cannot reconstruct the missing details. Membership-event
fan-out, controller idle waits, metadata catch-up, inventory stabilization and
persisted-receipt latency remain separate questions.

## Shutdown boundaries

The previous 20-second deadline awaited the whole stop-command reply. That
command included `Peerbit.stop()`, a post-stop directory scan, and IPC delivery.
Its timeout did not localize the failure to Peerbit shutdown or native cleanup.

Profile-enabled workers now emit externally visible point/span markers for:

1. Command received and dequeued.
2. `Peerbit.stop()` entry and returned-promise settlement.
3. Its instance-local bootstrap-recovery transition, handler stop, storage
   close, indexer stop, and libp2p stop calls.
4. Disk scan entry and settlement.
5. IPC reply begin, end or error.

The parent independently records command send, reply receipt and actual child
OS exit. High-level method observation uses normal instance wrappers, preserves
`this`, arguments, original return/promise identity and original errors, then
restores owned descriptors. No shared prototype or node_modules file is patched.
The current Peerbit stop sequence invokes the bootstrap transition with `false`.
That transition can internally catch errors; a fulfilled span means its original
call fulfilled, not that all nested work was error-free.

Worker traces retain/emit at most 64 events each, with accurate fixed-label
pending counts after truncation. At most two stop requests per worker are traced
(normal stop plus error cleanup). The parent retains at most 96 shutdown records
per worker. Request-local closures and explicit command IDs prevent a queued
cleanup from relabeling earlier spans. Each parent stop attempt also owns its
start time and reply state; delayed checkpoint responses retain that attempt's
identity rather than using a later attempt's clock.

At 5 seconds and 19 seconds after each stop attempt starts, the parent records
its last observed pending labels and requests a fresh trace snapshot through the
worker's existing out-of-queue profile command. The optional snapshot has a
750 ms bound and is not awaited on the stop path. Actual checkpoint elapsed time
is recorded separately from its scheduled time. The worker-reported request ID
can differ from the checkpoint's request when an older stop is still active.
Missing checkpoint replies are diagnostic gaps, not proof of which phase stalled.

The original **20-second stop-command and subsequent 15-second natural-exit
deadlines remain unchanged**. Actual operation errors and forced termination
still fail the run. Diagnostic IPC failures do not alter process exit status.
Logging is not awaited, but it still adds some IPC/serialization work; profiling
overhead has not been measured. Worker-relative and parent-relative timestamps
have different origins: use same-clock differences, never subtract between them.
Spans overlap/nest and their sums are not CPU time or a wall-clock critical path.

Only expand libp2p service-level tracing if that high-level phase is actually
pending. If an unchanged-deadline diagnostic reproduces a stall on macOS, a
one-second native sample may be taken of the exact owned worker PID while it is
still alive. No native sample was warranted by the successful smoke test below.

## Validation and provenance

- 49 unit tests pass: 12 placement-analysis, 5 topology, 17 profile/error and
  15 stop-trace/method-observation cases. They cover memory limits, malformed
  fields, unknown versus false/zero values, late larger spans, pending phases,
  original promise/error identity and descriptor restoration ownership.
- Standalone strict TypeScript checking and explicit lint/formatting pass.
- One fresh, empty, offline worker using released Peerbit 5.4.1 completed the
  real instrumented shutdown, emitted all 18 expected markers in order and
  exited naturally with code 0. The smoke checked unchanged worker/helper hashes.
  This validates basic wiring, not a delayed checkpoint, a populated N=3 case,
  a network failure or a latency improvement. No retry was used.
- Package-content checks pass; every diagnostic helper/test is excluded from
  published library/CLI artifacts. No install, dedupe or dependency edit occurred.

Evidence is retained under `/private/tmp/peerbit-performance-20260905/`:

- `adaptive-diagnostics-v3-units.log`
- `adaptive-diagnostics-v3-final-types.log`
- `adaptive-diagnostics-v3-lint.log`
- `adaptive-diagnostics-v3-package.log`
- `adaptive-diagnostics-v3-offline-smoke.mjs`
- `adaptive-diagnostics-v3-offline-smoke-first.log`

Smoke raw SHA-256:
`65a74f4a69d84ba80b5d907525f8c9780ccebcdd40078db865640d5cda7127cf`.

The smoke retained state directory
`/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-stop-trace-smoke-teIIz6`;
worker PID 91300 exited normally. The experiment now reports schema
`shared-fs-split-plane-probe-v3` and hashes the new stop-trace helper alongside
the driver, worker, model, profile helper, storage helper and lockfile.

Use the original opt-in command with `PROFILE=1` for a future explicitly labeled
diagnostic/rebaseline. Keep earlier raw logs immutable. Wait for a verified
published coherent cohort before the planned upgrade; do not install provisional
versions or interpret unreleased profiling as a controller-policy fix.
