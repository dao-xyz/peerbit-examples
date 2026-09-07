# Bounded sparse metadata batching prototype — 2026-09-07

## Status

Test-only `SparseMetadataBatchClient.lookupMany` reduced logical scan queries from **635 to 413** in the completed 5,000-file samples, while both returned **635 rows and fetched 127 chunks**. The measured revision passed 29 pure boundary tests; the unmeasured follow-up below passes 30. There is **no wall-clock speedup conclusion** and no production behavior change.

The timing campaign was stopped after a scheduling mistake: the root agent started `batch-b2` before `batch-b1` had finished. Both raw logs are preserved and both timings are excluded from an isolated A/B comparison. Unrelated `@instafy/frontend` `test:unit` / Vite build activity was also observed on the host; upstream confirmed it was not theirs. Host isolation was not established for this campaign, including the otherwise sequential controls and baseline. `baseline-a2` was **not run**; there were no retries or replacement samples.

## Five actual network runs

Times below preserve observed values, not valid isolated performance comparisons. All five runs had zero retries and zero missing strict instrumentation.

| Label                | Fixture / scanned files | Outcome / natural exit              |     Open ms |              Scan ms | Logical queries / rows / chunk fetches |
| -------------------- | ----------------------- | ----------------------------------- | ----------: | -------------------: | -------------------------------------- |
| `baseline-control64` | 64 / 63                 | Pass / 0                            |     376.528 |            1,942.419 | 315 / 315 / 63                         |
| `batch-control64`    | 64 / 63                 | Pass / 0                            |     170.663 |              576.381 | 205 / 315 / 63                         |
| `baseline-a1`        | 5,000 / 127             | Pass / 0                            |     172.266 |            4,826.428 | 635 / 635 / 127                        |
| `batch-b1`           | 5,000 / 127             | Pass / 0; overlapped `b2`           |   1,218.370 | 18,910.730; excluded | 413 / 635 / 127                        |
| `batch-b2`           | 5,000 / not reached     | `TimeoutError` / 1; overlapped `b1` | Not emitted |          Not reached | Not emitted                            |

`baseline-a1` finished before `batch-b1` started. Vitest start times for `b1` and `b2` were 14:15:25 and 14:16:02 local time; `b1` lasted 58.91 seconds, confirming overlap. The successful `b1` remains evidence of the checked result/count invariants, but its latency is not an isolated variant measurement. The controls do not repair the invalid 5,000-file timing comparison.

`b2` preserved the original `TimeoutError: The operation was aborted due to timeout`. Its report contains `sourceDocuments: 15002`, then no `openMs`, residency or scan fields. In the frozen fixture, source document recording is at lines 139–140; observer creation/dial/open precede `openMs` at line 153, and the reader/batching helpers are constructed later. Both peers reached cleanup and their stops fulfilled. The evidence therefore bounds the failure to after source-document recording and before successful observer-open timing was recorded; it does **not** identify the exact pending API or a batching-path failure. Neither host activity nor overlap is proven to have caused this timeout.

All four successful runs checked payloads, the fixed cache, eviction/reread, edit, cross-directory rename, delete and reconnect behavior. The two successful 5,000-file scans each ended with four cache entries / 16,384 bytes, 124 evictions and zero scan cache hits. Each had 15,002 source documents; the controls had 194. In every successful run the observer retained zero document rows, log entries and replication ranges, and the same one 178-byte block before and after the full checks. Both peer stops fulfilled in **all five** runs. Successful cleanup does not change `b2`'s failed result or fill in its missing scan evidence.

The existing `SparseQueryClient`, its single-file methods, byte cache, content verification, mount implementation and authorization wiring are unchanged. The new helper has no cache, write API, replication joins or push subscriptions. It queries one explicit source and labels every result `single-source-non-atomic`; `not-observed` is not authoritative deletion or a complete namespace statement.

## Bounded two-stage design

At most eight independent slots are admitted per operation:

1. Query one Documents store using `Or` of complete `And(kind, parentId, name)` branches. Exhaust bounded pages and close the iterator.
2. Only then query `Or` of complete `And(kind, nodeId)` branches for the discovered candidates. Again exhaust bounded pages and close before returning results.

Each result uses only node IDs discovered for its own original slot. A candidate moving from one requested slot into another during revalidation cannot become an undiscovered claimant of the second slot. Stable-node history checks retain the original prototype's single-head rule: among returned rows, reject zero or multiple unreferenced heads. This catches the tested zero-head cycle and multiple-head conflict cases, but is not a general DAG validator. Contested-slot, move-out and tombstone handling is retained. A discovered candidate with missing history fails as unavailable instead of returning absence.

Remote options remain `local:false`, `resolve:true`, explicit `from`, `replicate:false`, `throwOnMissing:true`, `retryMissingResponses:false`, and a 5,000 ms deadline. No custom `canSearch`/`canRead` shim is installed. The published public `And(Query[])` / `Or(Query[])` API is used; default search fetch size is not treated as completeness. Pagination stops only at iterator completion, with at most 64 pages per query and 64 returned rows across the entire operation. A sentinel row detects overflow. Requested slots and discovered candidates are each capped at eight; an excessive/contested batch fails rather than truncates. This total batch budget is intentionally stricter than giving every baseline lookup an independent 64-row budget.

Caller limits and requested slots are copied. Every required limit is validated from an owned snapshot, including calls from untyped JavaScript: missing fields, null/nonobject/partial objects, extra enumerable keys, nonpositive/noninteger/nonfinite values and values above hard caps are rejected. Hard caps are eight keys, 64 total operation rows, 64 pages per query, 64 requested rows per page, and 5,000 ms. The default page size remains eight; allowing a page up to 64 cannot bypass the shared row/sentinel budget. Explicit disconnect/reconnect invalidates the batch session; cancellation is checked after both page reads and iterator close. Query and close failures preserve each lone rejection, including `undefined`; dual failure aggregates the original query error first. The unchanged reader must still run `readNode` to refresh naming/version metadata and validate every returned byte. Callers using both helpers must invalidate both sessions together.

## Measurement fixture and limits

The separate default-skipped `sparse-metadata-batch.bench.test.ts` uses the same deterministic 4,096-byte payloads and `/cold/f-N.bin` fixture as the earlier sparse scan, on the newly installed published cohort. Both variants create fresh source/observer peers, do the same initial/warm read, scan files 1–127 in order, and retain the original four-entry / 16,384-byte cache. The variant batches lookup stages in groups of eight; subsequent `readNode` calls stay sequential and unchanged. The baseline retains its original lookup-then-read ordering.

Both variants have identical outer timers and logical query/row counters, without phase/transport wrappers or assumptions about `Or` query classification. Logical query count is not page, RPC, payload-byte or wire-traffic count. For the simple fresh fixture, expected logical queries are 635 baseline versus 413 variant (32 batched lookup queries plus 381 unchanged read queries); both variants assert 635 returned rows. This arithmetic is not a latency prediction. Histories or pagination can change cost.

The benchmark checks every selected payload, cache bounds/evictions, observer document/log/range/block residency, reread after eviction, edit, cross-directory rename, delete and session reconnect. Both variants execute the same post-scan compatibility checks. Runtime package entry hashes and source/lock hashes are captured; source hashes are rechecked. All peer stops are attempted and cleanup errors fail the test. The original 120-second test deadline and 5-second query limit remain unchanged.

The intended sequence was two 64-file controls followed by four distinct 5,000-file samples in A/B/B/A order. Only A/B/B ran, with the overlap described above; the campaign is stopped. The command below documents how a recorded sample was invoked, not an instruction to resume or replace failed samples. Do not compare these timings with the old cohort's 1.83/2.08-second instrumented scans. Same-process memory-store samples do not establish WAN, persistent-disk, multiplayer-write or scaling performance.

```sh
source /Users/marcuspousette/git/peerbit-examples/.envrc
cd /private/tmp/peerbit-sparse-metadata-batch-20260907
PEERBIT_SHARED_FS_METADATA_BATCH_BENCH=1 \
PEERBIT_SHARED_FS_METADATA_BATCH_MODE=baseline \
PEERBIT_SHARED_FS_METADATA_BATCH_LABEL=baseline-a1 \
PEERBIT_SHARED_FS_SPARSE_FILES=5000 \
  pnpm exec vitest run --config scripts/shared-fs-strict-tests/vitest.config.mjs \
  --retry=0 packages/shared-fs/library/src/__tests__/sparse-metadata-batch.bench.test.ts
```

## Exact provenance and immutable raw evidence

All five emitted identical package-entry and source/lock provenance: Node `v24.13.1`, Darwin arm64, on the linked `/private/tmp/peerbit-cohort-rebaseline-20260907` install. The following five package entry hashes and five source/lock hashes were independently rechecked against disk after the campaign and match. This is the recorded entry-point provenance, not a claim that every transitively imported file was individually traced. Successful runs also reached the fixture's final provenance recheck; `b2` did not reach that check.

| Recorded runtime package | Version | Entry SHA-256                                                      |
| ------------------------ | ------- | ------------------------------------------------------------------ |
| `peerbit`                | 5.4.2   | `036017a11d1ca1fb87c5cbc6da3cc8a87c9638942284a538884cfcdb0c4123ce` |
| `@peerbit/document`      | 15.1.2  | `85fe7d7107c688a6f64950b2c1ed218d0ec47d7ad73e3b04c30c1cd6dbe27e1d` |
| `@peerbit/shared-log`    | 16.0.32 | `f025f36e107f5f42e602ad4d1bbc62be0d12401308f7d2e23fdcc563d7fc9699` |
| `@peerbit/crypto`        | 3.1.6   | `e07fe60c0cdc53b2d982cdd38a4b3d407b9b13a8e11ffc5155908ddb71560420` |
| `@dao-xyz/borsh`         | 6.0.1   | `9f10dee11c13b08e8112c694b5ab3d5f08430dc22b796ff5f9207c2157ba70f1` |

| Measured source                       | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `sparse-metadata-batch.bench.test.ts` | `f91c4acdd35d44c45c4891ad253850fe82914edd0e0dabe6147a01dd2df6eb24` |
| `sparse-metadata-batch.ts`            | `7fcc6b4dd190f65ce263b8114bb9ff00f7056c548bb99dc6922ccd8bf3312037` |
| `sparse-query-client.ts`              | `47be2fe7c4bca2ae104f7d4c39c780310a44aa24d247d7e970be466dd9304590` |
| `sparse-query-cache.ts`               | `11611b6956c87ce5f9d6c96c625f773f3fb9f89f77c26ec423428dade413b6ff` |
| `pnpm-lock.yaml`                      | `eac8e78682fc29c70c62c77a73215348de435e5019d7632a99a163b1f07763bd` |

Raw prefix: `/private/tmp/peerbit-sparse-metadata-batch-20260907-`; each table label below has suffix `-first.raw.log`.

| Raw label            | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `baseline-control64` | `e92bdc7763efbb67e81d66352ea60a64f2d35c5675605a26d95155373f831346` |
| `batch-control64`    | `1a74f19319c17638c1a8586a6e82f2396388cf2081284a7963710c3fbd295449` |
| `baseline-a1`        | `0046d3ec8d91e00203ccec735a844d8d8ac63ba88167e962f2b8c015ff0a0f11` |
| `batch-b1`           | `8c95bbf2fba3dcb415efe515588971cd3aa20e30de2b7c9ab1bfd5be93514936` |
| `batch-b2`           | `6583fac6fa77c9295db591cefaf7fa31dbcad48eff80799ef5b1bc368ac41ffb` |

## Pure validation and subsequent review

- `/private/tmp/peerbit-sparse-metadata-batch-20260907-pure-first.log`: 23 tests passed, zero retries / missing instrumentation, natural exit 0. These are mock transport-boundary tests using real model/query classes, not network or source-convergence proof.
- `...-typecheck-first.log`: one test-only empty-array inference error; preserved unchanged.
- `...-typecheck-corrected.log`: explicit baseline-result array type applied; helper, pure tests and opt-in benchmark pass focused no-emit typechecking.
- `...-lint-first.log`: one test-only `prefer-const` diagnostic, preserved; `...-lint-corrected.log` passes after that declaration fix. All four new files pass formatting checks.
- Review identified that validating only supplied values allowed untyped partial limit objects to omit bounds, and that caller-provided values could exceed documented limits. Required-field validation and hard caps were added before any network measurement. `...-limits-pure-first.log` passes 29 tests with zero retries / missing instrumentation and natural exit 0; `...-limits-lint-first.log` passes. `...-limits-typecheck-first.log` preserves a mapped input type accidentally inheriting `readonly`; the input type was corrected without a runtime change, and `...-limits-typecheck-corrected.log` passes.

Independent post-run review identified one further test-helper lifecycle issue: the measured `lookupMany` sets `busy=true` before constructing `AbortSignal.any` outside its `try/finally`. An invalid signal supplied by an untyped caller can therefore leave the helper busy after rejection. The measured fixture supplies no such signal, and the `b2` failure occurred before the helper was reached, so this finding does not explain that failure. All new helpers/tests remain under `src/__tests__`, excluded from the published library build.

### Unmeasured follow-up revision

Commit `f793db8ecc210e0adf3018f7fddbc3b4319ee350` preserves the exact measured sources and five-run evidence above. The subsequent narrow helper revision moves signal construction inside the existing `try/finally` and adds a pure invalid-signal-then-valid-call regression. It does not change the original reader, cache, benchmark fixture, dependencies or frozen logs. No network run or recorded timing tests this later cleanup fix; the measured helper hash in the table intentionally refers to the earlier commit.

Follow-up validation passed first attempt: 30 pure tests, zero retries / missing strict instrumentation, natural exit 0; focused no-emit typecheck, explicit ESLint and formatting also passed. Preserved logs use `/private/tmp/peerbit-sparse-metadata-batch-20260907-signal-cleanup-` with suffixes `pure-first.log`, `typecheck-first.log`, `lint-first.log` and `format-first.log`.
