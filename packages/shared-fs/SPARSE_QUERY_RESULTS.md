# Sparse query client: read-only feasibility probe

Follow-up: [2026-09-07 phase profiles](SPARSE_QUERY_PROFILE_RESULTS.md) captured one slow naming query before decoded response observation. Upstream messaging subsequently succeeded; the original delivery failure recorded below is historical.

This is a **test-only prototype**, based on held integration `52386c31072931dc42f7b12b683734f59020ace1`. It does not change production mounts, writable readiness, replication defaults, the wire schema, authorization, dependency pins, or release gates.

## Outcome

A real shared-fs source containing **5,000 files / 15,002 documents / 20,480,000 payload bytes** was opened by a nonreplicating observer. The probe read one file, then scanned a total of 128 distinct files. Its retained read cache stayed at **4 entries / 16,384 payload bytes**, with 124 evictions at the end of the scan.

The observer's local state was identical before reads and after edits, rename, reconnect, and deletion:

| Local observer state | After open | After scenario |
| --- | ---: | ---: |
| Documents | 0 | 0 |
| Entry-log records | 0 | 0 |
| Replication ranges | 0 | 0 |
| Blocks | 1 | 1 |
| Block bytes | 178 | 178 |

The one block is the post-open manifest baseline, not a file chunk. The test independently counts blocks and their bytes, with explicit diagnostic scan limits. No blocks are deleted to achieve this result.

The source performs the writes. The observer is read-only. This is **not** a multi-writer sparse mount or an adaptive-custody/durable-N test.

## What the prototype does

- Uses the existing `SharedFsEntry`, `NamingEvent`, `FileVersion`, and `FileChunk` schema through real `openSharedFs` programs; no alternate miniature FS schema.
- Opens the observer with `replicate:false, bootstrap:false`.
- Makes finite `Documents.index.iterate` queries with `local:false`, an explicit source identity, `remote.replicate:false`, missing-source errors, no missing-response retries, an overall operation signal, and explicit iterator cleanup.
- Discovers an exact parent/name slot, then queries its candidates by stable node ID. A move outside the old predicate therefore invalidates the old slot.
- Refreshes naming and content explicitly. The test serializes source mutations and reads while the source is quiescent; it does not claim an atomic multi-query snapshot.
- Reconstructs content using the exact version's ordered, multiplicity-preserving `chunkIds`. Verifies chunk IDs, chunk hashes, whole-file hash, and size.
- Caps rows per operation, pages per query, chunk count, retained cache bytes/entries, file output size and one in-flight operation. Closes iterators on success/error and preserves simultaneous query/cleanup failures.
- Invalidates a session and clears cached bytes on an explicit disconnect notification. Reconnect creates fresh queries; old asynchronous completions cannot populate the new session's cache.
- Fails closed on conflicting/cyclic heads, contested slots, unavailable content, exceeded budgets, or invalid responses. An empty successful query is `not-observed` at the selected source, **not global absence**.

## Tests and measurements

The first 64-file control and the first 500-file run passed with strict reporting, zero retries, and natural process exit 0. The 5,000-file run also passed first attempt: 41 tests (11 cache, 29 query-boundary, one real-network scenario), zero retries/missing instrumentation, natural exit 0. After adding cleanup-error and constructor tests, final validation passed **57 tests** (11 cache, 45 query-boundary, one 64-file real-network scenario), zero retries/missing instrumentation, natural exit 0. Explicit test-file typechecking, ESLint with `--no-ignore`, Prettier, and the library build also pass. No full-library suite or cross-platform campaign was run for this test-only slice.

| Fixture files | Source documents | Open call | First path lookup + read | Warm stable-node read | Timed subsequent scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| 64 | 194 | 183.34 ms | 57.61 ms | 15.51 ms | 63 files / 835.20 ms |
| 500 | 1,502 | 245.70 ms | 39.89 ms | 8.89 ms | 127 files / 1,478.32 ms |
| 5,000 | 15,002 | 172.94 ms | **4,886.88 ms** | 8.61 ms | 127 files / 1,766.12 ms |

These are separate, single local-process observations, not a distribution, WAN result, controlled speedup comparison, or filesystem-throughput claim. Both peers use the normal transport configuration on the same machine. Source creation/population and the post-open readiness wait are outside `openMs`. First-read timing includes two slot lookups and a file read; warm timing only includes a stable-node read. Timed scans include query/assertion overhead. Small test instrumentation additions between runs do not support precise cross-run comparisons.

**The 4.89-second cold-read delay is unresolved.** Functional selectivity passed, but the cold path must be profiled by readiness/query phase before claiming predictable latency or assigning a cause upstream. No timeout was increased and no failed campaign was retried.

The pure tests additionally cover a 10,000-operation independent cache oracle, ownership of mutable byte buffers, overflow, no-progress pages, missing-source refresh despite warm bytes, content/layout corruption, conflicts, aborts, and stale results during both iterator fetch and cleanup.

### Reproduction

Use the existing coherent installation. Do not install/dedupe or change dependency pins for this probe.

```sh
source /Users/marcuspousette/git/peerbit-examples/.envrc
cd /private/tmp/peerbit-sparse-client-20260906
pnpm exec vitest run --config scripts/shared-fs-strict-tests/vitest.config.mjs \
  packages/shared-fs/library/src/__tests__/sparse-query-cache.test.ts \
  packages/shared-fs/library/src/__tests__/sparse-query-client.test.ts \
  packages/shared-fs/library/src/__tests__/sparse-query-network.test.ts

# Separate scale variant; the same deadlines/assertions, not a failed-run retry.
PEERBIT_SHARED_FS_SPARSE_FILES=5000 pnpm exec vitest run \
  --config scripts/shared-fs-strict-tests/vitest.config.mjs \
  packages/shared-fs/library/src/__tests__/sparse-query-network.test.ts
```

Environment: Darwin 25.6 arm64, Apple M3 Pro, Node 24.13.1, pnpm 10.26.1, Vitest 4.0.18. Dependencies are reused from `/private/tmp/peerbit-cohort-integration-20260905`, with no install, dedupe, overrides, or edits to dependency source.

Installed cohort: peerbit 5.4.2; document 15.1.0; shared-log 16.0.30; program 6.0.60; trusted-network 6.0.131; blocks 4.3.1; blocks-interface 2.2.1; crypto 3.1.6; Borsh 6.0.1.

Lock SHA-256: `f5c3a197949daccb71ae4fd2585704287d025c83499b2d84d5e0f5b255f924b9`.

Raw local artifacts:

- `/private/tmp/peerbit-sparse-client-20260906-network-first.log`
- `/private/tmp/peerbit-sparse-client-20260906-network-500.log`
- `/private/tmp/peerbit-sparse-client-20260906-network-5000.log`
- `/private/tmp/peerbit-sparse-client-20260906-validation-final.log`
- `/private/tmp/peerbit-sparse-client-20260906-typecheck-final.log`
- `/private/tmp/peerbit-sparse-client-20260906-build.log`

Raw log SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| First 64-file run | `6da046f499363c7ca476387c879c088c9948c21bdc80accdecab0045f96723d4` |
| First 500-file run | `03284c87f1ae26abb145311798f16b9bcd5e794a10d5d7b9ba3015f0d2a271be` |
| First 5,000-file run | `11fbef077a4f056dc09c35510fb92b8fe4aa5a5d53a5fad24a7f954daee4a749` |
| Final 57-test run | `95a0d1ca4b4c123457f4282ce220fbf472357cd42a73e5b409065c48fc9830aa` |

## Boundaries and next steps

1. **Live updates are not yet bounded read-cache subscriptions.** Installed Documents remote pushed updates force replication. Query-driven `replicate:true` joins create persistent ranges; iterator close does not release them. Individual unreplication is rejected while adaptive replication is active. This probe intentionally uses explicit nonreplicating refresh instead.
2. **Sparse writes need more than a successful query.** This probe does not establish global namespace coverage, conflict resolution across incomplete histories, writer readiness, or persisted receipts. It supports neither production mount writes nor offline freshness. Existing N=3 failures remain unchanged and were not rerun.
3. **Authority is separate.** This is an anonymous functional fixture with a pinned query source and content-address verification. It does not implement independent remote metadata signature/authorization validation, read confidentiality, identity-provider integration, or trust revocation.
4. **Memory accounting is scoped.** Cache bytes count retained payloads, not Map/key overhead, total heap, transport buffering, or hostile-response peak memory. Resolved documents are received/deserialized before size validation; metadata string/parent-array byte limits remain future work. Caller-retained read results are outside the cache budget.
5. **Physical custody is separate.** No physical reclamation or hard peer-wide disk quota is implemented. Existing safety gates remain; release of a demand pin must never be treated as proof that shared blocks can be deleted.
6. **No shutdown guarantee is invented.** Iterator cleanup and peer shutdown are awaited. A hang or rejection is a failure to investigate, not silently ignored or force-exited as success.

Next downstream slice: phase-profile the first sparse query, then define source freshness/interest refresh contracts and observer-side metadata authorization. Follow with concurrent-writer/ancestor-rename coverage before considering production sparse mounts.

## Upstream request (not delivered)

The app could read the existing upstream task, but sending to it failed with `thread not found`, including one explicit-host attempt. This request has **not** been delivered:

> Please keep this separate from the pending release. Shared-fs now has a test-only nonreplicating query reader: a 5,000-file/15,002-document source, 128 distinct files read, a four-chunk/16 KiB cache, and no growth in the observer's document/log/range/block residency. Explicit refresh sees edit/rename/delete/reconnect; this is not live push, independent metadata authorization, global completeness, adaptive custody, or N-receipt proof. Installed shared-log 16.0.30 rejects individual unreplication during adaptive replication; Documents remote pushed updates force persistent query-result replication. Is there a supported scoped demand-pin acquire/release API independent of adaptive custody? If not, please consider bounded, reference-counted ownership of overlapping read pins versus adaptive assignments, cancellation/session/reopen behavior, and no pruning while another owner still needs data. Pin release must not imply safe physical shared-store deletion. A separate 5,000-file local observation had a 4.89-second first path lookup/read despite a 173 ms open call; no cause is assigned yet—we need query/readiness phase profiles before treating it as an upstream defect. No dependency changes or unchanged N=3 reruns were made.
