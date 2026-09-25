# Exact slot cache: 100k-row resource campaigns

The bounded exact-slot implementation removes parent-width materialization
from cold point lookups. It bounds retained candidate rows, but **does not**
bound the transient cost of a full directory sweep or an oversized single-name
history. PR #331 remains held for those tradeoffs and first-attempt integration
validation. This report preserves the original campaign below as historical
evidence, followed by the matched bounded-cache campaign.

## Historical v1 campaign: reproduction and scope

This section describes the worker and production code at `5479d691`. The current
worker uses the v2 sequence documented later; do not compare its distributions
directly with the historical v1 distributions.

Run from the repository root with the existing lockfile installation:

```sh
PEERBIT_SHARED_FS_SLOT_RESOURCE_BENCH=1 pnpm exec vitest run packages/shared-fs/library/src/__tests__/slot-candidate-resource.bench.test.ts --retry=0
```

Set `PEERBIT_SHARED_FS_SLOT_RESOURCE_WIDTH=100` for a harness smoke. The default
is 100,000; each case runs sequentially in a fresh `node --expose-gc --import tsx`
process with an external three-minute deadline. A timeout is a failed result.
Direct worker invocations take the width and `unique` or `same-name` arguments.

The fixture streams real `IndexableSharedFsEntry` rows into the installed
Peerbit SQLite index, closes/reopens that disk index, and adapts its index-only
queries to the actual filesystem `sweepRows`, `slotRows`, installation, change
invalidation, and eviction methods. There are no Documents writes,
authentication, replication, file bytes, or mounted operations. Timings stop at
candidate-history lookup; resolving a visible winner or doing `fs.stat`/`fs.list`
would add work. The full-list control is `sweepRows`, not public `fs.list`.

"Cold" means an empty application slot cache. The operating-system page cache
is not dropped, and the old id-map control has already exercised the SQLite
query before the first timed point lookup. These results are not cold-disk or
cold-join measurements. Each warm distribution has 500 samples, with a fixed
random seed for unique-name hits and distinct absent-name misses.

Each memory checkpoint records before-GC values, requests GC three times with
an event-loop turn between requests, then records after-GC values. No explicit
GC runs between the three rejected mutation fills. Observed peaks sample
query completion, cache installation boundaries, and checkpoints; allocations
inside synchronous calls can exceed these sampled maxima. V8 and native
allocators can retain RSS after object collection. Retained cache memory is
therefore estimated separately using after-GC heap deltas.

## Historical v1 result, 2026-09-05

Host: macOS arm64, Node 24.13.1. This is the held PR's existing dependency
cohort, not the pending upstream refresh: `peerbit@5.3.35`,
`@peerbit/document@15.0.16`, `@peerbit/shared-log@16.0.15`, and the directly used
`@peerbit/indexer-sqlite3@3.0.19`. Lockfile SHA-256:
`4a4a8df381f6abb29fa12d604a6c8a1b7c5487ed3df6273b7e069422dc475f57`.
The raw fixed-run reports include the cache source SHA-256 and every memory
checkpoint:

- [100k unique names](library/src/__tests__/fixtures/slot-resource-100k-unique-darwin-arm64.json)
- [100k same-name rows](library/src/__tests__/fixtures/slot-resource-100k-same-name-darwin-arm64.json)

The original builder repeatedly searched a growing same-name array. Its three
observed install samples were 4.5–6.0 ms at 1k rows and 251–368 ms at 10k rows.
The original 100k same-name campaign exceeded approximately three minutes and
was terminated; its seed finished in 10.6 seconds, but no final timing report
was produced. This is a censored timeout, not a measured per-install duration.

The fix uses temporary id-keyed maps for collision histories during bulk
construction, then compacts them to the existing retained representation.
Same-name replacements preserve position; moving an id away and back preserves
the prior removal/reinsertion ordering. Live incremental upserts are unchanged.
A deterministic 2k-row regression counted 4,006,000 identity reads in the old
code and passes the linear-work bound with the fix.

This bounds the bulk grouping constructor, not every surrounding installation
case. Relocating many existing ids out of one other cached same-name parent
still filters that shrinking history for each removal and can be quadratic.
That pre-existing relocation path needs separate treatment; the measured cold
fills have no previously cached source parent.

| Fixed 100k case                      |                    Unique names |                One shared name |
| ------------------------------------ | ------------------------------: | -----------------------------: |
| Cold hit                             |                        1,052 ms |                       1,375 ms |
| Cold miss                            |                        1,075 ms |                       1,131 ms |
| Warm hit p50 / p95 / p99             |  0.00121 / 0.00225 / 0.00333 ms |       0.0685 / 0.155 / 1.91 ms |
| Warm miss p50 / p95 / p99            | 0.000833 / 0.00138 / 0.00250 ms | 0.000500 / 0.00288 / 0.0118 ms |
| Warm full candidate sweep            |                         3.83 ms |                        1.84 ms |
| Cold full candidate sweep            |                        1,203 ms |                       1,136 ms |
| Three bulk installation samples      |                96 / 144 / 90 ms |             145 / 137 / 119 ms |
| Name-map entries / reverse entries   |                     100k / 100k |                       1 / 100k |
| Retained heap above released control |                        52.26 MB |                       49.38 MB |
| Old id-map retained heap control     |                        44.72 MB |                       44.72 MB |
| Sampled maximum heap / RSS           |                1,255 / 1,544 MB |               1,259 / 1,611 MB |
| Final released heap                  |                        64.53 MB |                       64.54 MB |

MB means decimal megabytes. The unique-name cache adds about 7.54 MB retained
heap over the former id-keyed map at 100k rows. Both implementations first
materialize the same large index result; the sampled maximum RSS is not the
retained cache size. The fixed unique-name fill sampled 520.9 MB heap before GC
and 119.4 MB after GC (67.1 MB after releasing the control).

Forced eviction crosses the real 50,000-parent limit with empty control
buckets. The wide parent's 100k reverse entries are all removed. After clearing
the control buckets and collecting, heap returns to 67.33 MB (initial 66.88 MB).
There is no retained reverse-index leak in this experiment. The parent-count
limit still does not bound rows in one wide parent.

Three completed unrelated index writes were injected deterministically after
each SQLite snapshot and before cache publication. All three fills were
correctly rejected by the global mutation fence and each lookup re-read the
entire 100k parent. Unique-name samples took 1,072 / 1,039 / 1,188 ms. Before the
next explicit GC, heap reached 1,255 MB; after GC it returned to 66.35 MB while
RSS remained about 1,499 MB. This exposes repeated allocation and allocator
retention under mutations, not a retained-row leak. Removing the global fence
would lose same-id replacement protection and is not part of this fix.

The linear bulk fix adds 3,181 unpacked bytes and 778 compressed tar bytes over
the rebased cache PR (83 package files before and after). The final library
package is 2,219,037 unpacked bytes against the 2,750,000-byte budget. Benchmarks,
tests, and raw results are excluded from the package.

Verification passed the two new bulk-construction tests, seven slot-cache
tests, four fill/lifecycle race tests, and both fresh-process harness smoke
cases without retries. The library build, lint, formatting, and emitted-output
verification passed. Independent randomized old/new grouping equivalence
covered 10,000 campaigns and 2,513,641 rows without a mismatch.

## Historical v1 merge gate

Keep PR #331 held. Evaluate a bounded exact-slot query/cache policy and bounded
query materialization, including mutation-fence correctness for replacements
across names and parents. Re-run this campaign with that design and the next
upstream cohort. The linear bulk fix addresses the measured same-name defect;
it does not resolve approximately one-second cold point queries, large
transient index allocations, or repeated discarded fills under unrelated
writes. Full filesystem namespace and mounted benchmarks remain separate.

## Bounded exact-slot design, v2

The current implementation queries `kind = naming AND parentId = P AND name = N`
for a cold point lookup. Explicit partial-parent state distinguishes an unknown
slot from a known-empty slot. Only a fully retained sweep proves a complete
parent; eviction, oversized admission, and same-id relocation invalidate that
proof. Relocation evicts the prior source slot once instead of repeatedly
filtering a shrinking same-name array.

An internal helper owns the slot rows, reverse map, LRU, accounting, and shared
in-flight queries. Its defaults are 4,096 slot records plus parent markers,
16,384 rows, 8 MiB of estimated retained bytes, and 64 active point fills.
Negative entries count toward the limits. This is not an 8 MiB RSS limit.
Oversized results remain complete but are not retained. Excess callers await
capacity; the number of incoming caller promises and the size of each active
result are not bounded by this policy. Full sweeps are outside the point-fill
concurrency cap.

Generation, cache identity, revision, epoch, and mutation admission fences remain
in place. A later caller cannot join an older pre-mutation fill. Shared fills
return separate shallow array copies to callers. There is no new public API,
changed winner resolution, history truncation, or durability shortcut.

## Matched v2 reproduction and provenance

Use the same opt-in command above. The current v2 runner executes each shape
sequentially in a fresh process with the same three-minute deadline; width 100
is the smoke configuration. The final matched campaign used the **identical**
v2 worker against legacy production at `5479d691` and bounded production at
`4529da1c`, in this order: old unique, new unique, old same-name, new same-name.
Each case ran once. Host load was not controlled; these are observations, not
stable latency distributions or an end-to-end filesystem speedup.

The worker seeds 100k real disk-backed SQLite naming rows, reopens the index,
then measures the first cold hit, repeated same-name hits, a cold miss after
cache clear, repeated same-name misses, three mutation-rejected fills, 100
indexed naming creates, and a complete sweep after partial warming. It validates
the exact candidate identities, parent/name, uniqueness, and full sweep contents
outside the timers. There are 100 repeated hit/miss samples, except only three
hits for the oversized same-name case. Creates are index writes, not file writes
or persisted receipts. The new code also probes 128 negatives with small test
limits (32 entries, 64 rows, 32 KiB, four active fills).

Unlike v1, the first cold hit includes lazy SQLite planning/index creation.
Later cold-cache queries can reuse those indexes. The OS page cache is warm.
Actual prepared SQL and bindings are captured with light instrumentation;
`EXPLAIN QUERY PLAN` runs only after timed work and confirms a composite
`kind,parentId,name` point search. The remaining parent sweep uses
`kind,parentId`. Returned-row counts below are rows decoded from SQLite, not
rows visited internally by its planner.

Host: Apple M3 Pro, 12 logical CPUs, macOS arm64 (Darwin 25.6.0), 36 GiB RAM,
Node 24.13.1. All four cases executed the same existing cohort:
`peerbit@5.3.35`, `@peerbit/document@15.0.16`,
`@peerbit/shared-log@16.0.15`, `@peerbit/indexer-sqlite3@3.0.19`,
`@dao-xyz/borsh@6.0.1`, `@peerbit/crypto@3.1.6`.
No install or dedupe was run. This is **not** validation of the held upstream
5.4.0 cohort. All four reports share the historical lockfile SHA above and worker
SHA `d342e21fcc09c5bdd8fe3f3782dcc3dc3ce5fe94543685ee12a9af77e8941c29`.
Each report records production-source hashes and actual resolved module URLs,
real paths, and package/entry hashes. The worker rejects split Borsh identities
between its importing source and the SQLite indexer; a lockfile hash alone does
not establish the executed dependency graph.

Raw results:

- [Legacy, unique names](library/src/__tests__/fixtures/slot-resource-v2-before-100k-unique-darwin-arm64.json)
- [Bounded, unique names](library/src/__tests__/fixtures/slot-resource-v2-after-100k-unique-darwin-arm64.json)
- [Legacy, one shared name](library/src/__tests__/fixtures/slot-resource-v2-before-100k-same-name-darwin-arm64.json)
- [Bounded, one shared name](library/src/__tests__/fixtures/slot-resource-v2-after-100k-same-name-darwin-arm64.json)

## Matched v2 results, 2026-09-05

| Candidate lookup / index operation      |     Legacy unique |        Bounded unique | Legacy same-name |   Bounded same-name |
| --------------------------------------- | ----------------: | --------------------: | ---------------: | ------------------: |
| First cold hit, ms                      |          1,237.49 |                 94.68 |         1,760.23 |            1,282.31 |
| Rows returned by first hit              |           100,000 |                     1 |          100,000 |             100,000 |
| Cold miss after clear, ms               |          1,034.99 |                 0.571 |         1,046.66 |               0.854 |
| Rows returned by cold miss              |           100,000 |                     0 |          100,000 |                   0 |
| Repeated same hit p50, ms               |          0.000500 |              0.000625 |            0.102 |              985.32 |
| Three mutation-rejected fills, ms       | 917 / 958 / 1,014 | 0.674 / 0.319 / 0.270 |  901 / 906 / 870 | 1,093 / 1,199 / 915 |
| Naming-create p50, ms                   |            0.0665 |                0.1558 |           0.0700 |              0.1592 |
| Queries across 100 naming creates       |    1 parent sweep |      100 point misses |   1 parent sweep |    100 point misses |
| Full sweep after preceding workload, ms |             0.637 |              1,462.06 |            0.904 |            1,235.86 |
| Candidate rows retained after first hit |           100,000 |                     1 |          100,000 |                   0 |

The unique cold hit improved about 13.1x in this pair, including lazy index
creation. Subsequent miss/rejected-fill work no longer decodes 100k unrelated
rows. The new naming-create median is slower because each unseen name does a
point absence query, whereas the old first sweep proved the entire directory.
The first expensive old create is not represented by its median; query counts
are essential context.

The full-sweep comparison is deliberately **not** an equal-cache-state
comparison: legacy has already paid for and retained the entire parent; bounded
has retained only points. The bounded sweep returns all 100,100 rows correctly,
but cannot retain that result under its limits. A single name with 100k history
rows is also uncached, making each repeat roughly a second instead of copying
an already-retained result. These are real regressions for list-heavy and long
history workloads, not solved scaling problems.

Memory is reported in MiB here (v1 above used decimal MB). After the first unique
hit, heap rose from 63.92 to 113.92 MiB after GC with legacy, versus 63.97 to
64.16 MiB with bounded. This process-wide delta includes query initialization;
the bounded cache's 898-byte accounting estimate is not a heap measurement.
Through the unique point/create phases, bounded after-GC heap remained below
64.66 MiB and RSS below 398 MiB at checkpoints. Its full sweep still sampled
535.94 MiB heap before GC and 881.91 MiB RSS after GC, with no retained rows.
For the same-name case, bounded rejected fills sampled 1,181.14 MiB heap before
GC, then 64.45 MiB after GC; final RSS was still 1,475.58 MiB. Retained-cache
bounds do not solve transient allocation or native allocator retention.

The small negative-cache control finishes at 31 slots plus one parent marker,
6,232 estimated bytes, zero rows/reverse entries. All final cleared states have
zero retained rows, reverse entries, parents, slots, and active fills.

## Verification and current gate

Focused coverage passed 18 existing/budget/integration tests plus 19 independent
adversarial tests. Review caught and fixed false completeness after sibling
eviction, false completeness after oversized admission to an empty parent, and
shared mutable result arrays. Two v2 harness smoke cases passed. Builds,
changed-source lint/format, emitted-output, and package verification passed.
An independent backing-map oracle exercised 100,000 arbitrary install, add,
remove, evict, and clear operations across five budgets, checking 763,672 known
slot results and 55,104 complete sweeps without mismatch. It also checked
row/reverse equality, nonnegative accounting, and every retained-cache limit.

The full library command exited successfully with 549 passed and 13 skipped,
but one durable-disposal naming-conflict/tombstone test used its embedded
`retry: 1` despite CLI `--retry=0`. **The strict first-attempt gate therefore
failed.** The default reporter omitted the initial failure stack. A separate
diagnostic changed only that case to `retry: 0` in an isolated worktree and ran
once: it passed in 10.47 seconds. That does not clear the original failure or
establish its cause. No timeout was raised, no retry-until-green was performed,
and no diagnostic patch belongs in the PR.

The library package is 87 files, 2,241,961 unpacked bytes and 502,708 gzip bytes:
+22,924 unpacked / +5,072 compressed versus the linear-builder baseline, within
the 2,750,000-byte budget. CLI output is unchanged. Tests, benchmark reports, and
raw fixtures are excluded from packages.

Keep PR #331 held. Next gates are fresh cross-platform first-attempt results,
the coherent upstream rebaseline, a public namespace/mounted workload matrix
(point-heavy, list-heavy, history-heavy, concurrent writers), and a design for
bounded history/enumeration materialization that preserves the exact conflict
and tombstone semantics. This campaign is evidence for targeted point-query
improvement, not evidence that shared-fs is the fastest collaborative filesystem.
