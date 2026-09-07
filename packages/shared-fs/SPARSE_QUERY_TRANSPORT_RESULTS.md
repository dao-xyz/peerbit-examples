# Sparse read transport boundaries — 2026-09-07

## Outcome

The first 5,000-file sample captured a **149.093 ms source-publish → observer-data gap for one exact response message ID**. The following observer-data → RPC-response boundary was 0.174 ms. Request-direction publish → source-data spans were at most 3.469 ms. The second independent sample's largest response-direction publish → data span was 1.956 ms.

This is evidence of variability after response creation/signing and before the observer's public data event. It does **not** separate routing/queueing, transport, verification/ACK work or event-loop scheduling. It is not a server-handler duration, pure wire latency, proof of the earlier 2,855 ms query's cause, or a fix.

Both samples passed the unchanged sparse functional assertions. Later 127-file scans still took **4.10 and 4.53 seconds**, outside the detailed capture window. The performance tail remains unresolved.

## Scope and boundaries

This extends the test-only [phase profile](SPARSE_QUERY_PROFILE_RESULTS.md) at `c056760765481dccde43cf1b5eee4011a00a679d`, on the isolated sparse-query branch. No runtime mount, schema, authorization, query, readiness, timeout, replication, dependency or release gate changed. The original probe's `entries.waitFor` remains intact. This is still a read-only explicit-refresh prototype, not a writable sparse mount or live push subscription.

`PEERBIT_SHARED_FS_SPARSE_TRANSPORT_PROFILE=1` requires the existing `PEERBIT_SHARED_FS_SPARSE_PROFILE=1`. The passive recorder:

- Attaches public pubsub listeners on each peer before its Documents open. After open, discovers exactly one opened query `RPC` via public `entries.index.allPrograms` and requires matching singleton query topics.
- Keeps at most 512 primitive events and 128 unique outer IDs. Pre-arm/unrelated traffic is ignored; drops, duplicates, malformed metadata and callback errors are counted. It never reads envelope bytes, query predicates, response payloads, private `_query`, or retained message objects.
- Records public 32-byte outer IDs, optional public sender hashes, signed transport `header.session` values, and known request types/logical iterator IDs. Transport sessions are not request IDs or the local application generation.
- Uses exact same-outer-ID joins **within each direction only**: observer publish → source data → source RPC request; separately source publish → observer data → observer RPC response. No request/response cross-pairing, adjacency matching, object-identity bridge or server-handler attribution is performed.
- Stops after the first complete path lookup/read. Listener removal is included in the aggregate first-read timer; this additional diagnostic overhead is not measured separately. Subsequent scan traffic is not retained.
- Removes all listeners even if one removal throws. Diagnostic output/removal failure does not skip other diagnostics or either peer shutdown. Raw evidence is emitted before shutdown; actual process exit is checked separately.

Publish is after message creation/signing but before routing/queue/send, **not a sent/ACK proof**. Data is after verification, duplicate/recipient/topic checks and ACK handling, **not socket arrival**. RPC request is after decoding and immediately before its response handler. RPC response can also be emitted for intercepted/predicted responses; a standalone event is not ordinary wire-response proof. Only complete matching publish/data/RPC chains are measured here.

Both peers run in the same Node process. Align the two recorders using `clockOriginMs + atMs`; their raw `atMs` origins differ. Do not apply this subtraction across independent processes. The public response event does not expose `ResponseV0.requestId`, so even an overlapping local query delay cannot establish which original request produced that response.

## Measurements

Sequential fresh-peer runs; in-memory stores and default transports on Darwin arm64, not disk/fsync, WAN, multi-machine or N-receipt tests. The two 5,000-file samples are preplanned independent observations, not retries or a latency distribution.

| Scope, milliseconds | 64-file control | 5,000 first | 5,000 second |
| --- | ---: | ---: | ---: |
| Observer open | 175.84 | 158.30 | 391.52 |
| First path lookup/read, including checks and diagnostic cleanup | 44.28 | 230.36 | 75.66 |
| Longest request publish → source data | 5.965 | 3.468 | 2.473 |
| Longest source data → RPC request | 0.111 | 0.094 | 0.091 |
| Longest response publish → observer data | 2.760 | **149.093** | 1.956 |
| Longest observer data → RPC response | 0.546 | 0.466 | 0.404 |
| Later scan | 63 files / 651.50 | 127 files / **4,101.33** | 127 files / **4,530.42** |

Each boundary maximum is independent; do not sum maxima or pair table rows into a request/response exchange. The first sample's local query 3 took 157.360 ms; that overlapping timing is recorded separately, without an exact correlation bridge to the 149.093 ms response chain. Its chunk query took 2.108 ms. The second sample's chunk query took 2.114 ms. None proves what caused the later scan delays.

Exact slow response chain in the first sample:

- Outer ID: `gX5xJIREWWGrLVOaq+zrh3gf/CWzF8UBFdSYSk6z3Jo=`.
- Transport-relative times: source publish `4034.036875`, observer data `4183.129958`, observer RPC response `4183.304292` ms.
- Sender on all three: `2ukGNb/eQnOY7mbiLBBTO+AH9WFf7s8emvmh+YD1Q2g=`; transport session `1788762523239` on all three.

All three profiled runs produced **42 events, 14 outer IDs, seven complete chains per direction**, with every ID group containing exactly three expected boundaries. No unmatched, duplicate, malformed, dropped or callback-error event occurred. The local profile separately captured seven successful one-row queries and closes. No close/prefetch/collect RPC request appeared in the frozen transport window; absence says nothing about later traffic or custody release.

Each 5,000-file source held 15,002 documents / 20,480,000 payload bytes. Edit, cross-directory rename, delete, eviction/reread and reconnect refresh assertions passed. Observer documents, log entries and replication ranges stayed **zero**; its one block stayed **178 bytes**. At the scan boundary the read cache held four chunks / 16,384 bytes with 124 evictions. This does not authorize physical block reclamation or prove metadata authority/global completeness.

## Verification and reproduction

The first pure transport run passed 20 tests. The profiled 64-file control plus profile tests passed 44 tests. Both independent 5,000-file runs passed first attempt. Final default/unprofiled focused validation passed **100 tests** (11 cache, 45 client, 23 phase profile, 20 transport profile, one network). All strict summaries recorded zero retries and missing instrumentation; each process exited naturally with code 0. Explicit test-file typechecks, `eslint --no-ignore`, formatting and the library build passed. No full-library or three-OS campaign was run for this test-only diagnostic.

Runtime remains Node 24.13.1 / pnpm 10.26.1 / Vitest 4.0.18, Darwin arm64. Peerbit 5.4.2, Documents 15.1.0, SharedLog 16.0.30, RPC 6.1.28, Program 6.0.60, Trusted Network 6.0.131, Pubsub 5.4.6, Blocks 4.3.1, Crypto 3.1.6. **The newly released Documents 15.1.1 / SharedLog 16.0.31 cohort was not adopted here.** No install, dedupe, dependency-source edit, retry, timeout increase, transport disablement or forced-success exit occurred.

Lock SHA-256: `f5c3a197949daccb71ae4fd2585704287d025c83499b2d84d5e0f5b255f924b9`.

```sh
source /Users/marcuspousette/git/peerbit-examples/.envrc
cd /private/tmp/peerbit-sparse-client-20260906
PEERBIT_SHARED_FS_SPARSE_PROFILE=1 \
PEERBIT_SHARED_FS_SPARSE_TRANSPORT_PROFILE=1 \
PEERBIT_SHARED_FS_SPARSE_FILES=5000 \
  pnpm exec vitest run --config scripts/shared-fs-strict-tests/vitest.config.mjs \
  packages/shared-fs/library/src/__tests__/sparse-query-network.test.ts
```

Artifact prefix: `/private/tmp/peerbit-sparse-transport-20260907-`.

| Raw suffix | SHA-256 |
| --- | --- |
| `control64-first.log` | `6774f16bb6a0dabb652075384c61236202450a119963c387e2117a866584dea8` |
| `5000-first.log` | `52ee0f6aa2c4bc07abd3244a94c9109244f56667a672b31343fadd412a131663` |
| `5000-second.log` | `665d3a23e1155a276e5296ef692f5a25caf5c6d0e3929f7cced97427101bf57f` |
| `validation-first.log` | `1cb9fb79961d08b72ef1d025ea7c37e7fd0481b2c512adb30f14363ea183a78b` |

`control64-summary.json`, `5000-first-summary.json` and `5000-second-summary.json` contain independent exact-ID chains, separate local query timings, identities, sessions and raw-file hashes. `summarize.mjs` generated these without cross-pairing (SHA-256 `e3d917dcc6628530064b73c8abca61b7fac0c58e3a0357e65a93239f740b7ada`). `provenance-final.json` records resolved package versions, runtime-source hashes and all four instrumented-source hashes. An initial provenance-only probe used CommonJS resolution against ESM-only exports; it was corrected to ESM resolution, without rerunning a network sample. The `pure-first.raw.log`, `typecheck-first.raw.log`, `integration-typecheck-first.log`, `lint-first.log`, `format-first.log` and `build-first.log` preserve validation evidence.

## Coordination and next work

The upstream task **Investigate bounded shared-log state** supplied the public-hook guidance, confirmed the missing request/response correlation field, and received the exact first-sample evidence. Its advice to omit the optional object-identity bridge was followed.

The next useful downstream diagnostic is a bounded slow-query summary during the later scan, with matched one-way transport chains retained only for a bounded window. More source-handler attribution would require a separately reviewed public correlation addition. These findings do not justify changing cache/custody policy or removing readiness. Release adoption and unchanged N=3/three-OS acceptance remain separate work; the sparse observer still provides no independent metadata-authorization proof.
