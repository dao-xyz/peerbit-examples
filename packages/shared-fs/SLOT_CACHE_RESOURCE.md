# Exact slot cache: 100k-row resource campaign

The warm exact-name index removes directory-width scanning, but a cold point
lookup still materializes the entire parent history. This campaign found and
fixed quadratic bulk construction for same-name histories. It also confirms
that wide-directory cold latency and allocation need a separate design before
the cache optimization is ready to merge.

## Reproduction and scope

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

## 2026-09-05 result

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

## Remaining merge gate

Keep PR #331 held. Evaluate a bounded exact-slot query/cache policy and bounded
query materialization, including mutation-fence correctness for replacements
across names and parents. Re-run this campaign with that design and the next
upstream cohort. The linear bulk fix addresses the measured same-name defect;
it does not resolve approximately one-second cold point queries, large
transient index allocations, or repeated discarded fills under unrelated
writes. Full filesystem namespace and mounted benchmarks remain separate.
