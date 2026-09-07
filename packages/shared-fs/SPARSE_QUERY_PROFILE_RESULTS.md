# Sparse read phase profile — 2026-09-07

## Outcome

The first profiled 5,000-file run captured a **2,855 ms naming-metadata query**. Almost all of that span was before the public decoded RPC response callback. The content-chunk query took 1.70 ms and client iterator cleanup took 0.02–0.09 ms per query.

This narrows the measured delay to the path before client result introduction. It **does not** distinguish request scheduling, source-side work, transport, responder filtering, or response decoding, and does not prove the cause of the earlier 4.89-second sample.

A second independent 5,000-file run had a fast first read but a longer subsequent scan. The tail is not cleared. No readiness change, timeout increase, retry, new dependency, or production fix was made.

## Preserved baseline and instrumentation

Based on local bot-authored sparse prototype `7bb1a3ffda916f458605529476513d8b3799403c`, itself based on held integration `52386c31`. This diagnostic remains on the independent test branch; no production mount, schema, writable-readiness, authorization, replication or release gate changed.

The original 5,000-file log remains unchanged:

`/private/tmp/peerbit-sparse-client-20260906-network-5000.log`

SHA-256: `11fbef077a4f056dc09c35510fb92b8fe4aa5a5d53a5fad24a7f954daee4a749`.

Opt-in `PEERBIT_SHARED_FS_SPARSE_PROFILE=1` adds a test-only, non-mutating iterator facade and the existing `openSharedFs` open-profile callback:

- Separately measures dial, open, the original **`entries.waitFor`**, initial residency census, both path lookup operations, and the selected-node read.
- Times iterator creation, every explicit `next`, decoded response callbacks, and `close`, with local operation/query IDs and four fixed query-kind labels.
- Uses public **`remote.onResponse`**. This callback is after RPC response decoding/filtering and before Documents result introduction; it is not a wire-arrival, server-admission, or document-ready timestamp.
- Does not inspect or retain response payloads. Its capture is synchronous and nonthrowing. Existing callbacks, values, receivers and rejection identities are preserved, including `undefined` and paired query/cleanup failures.
- Caps detailed capture at 512 events and open spans at 64. Freezes after the first complete path lookup/read. Source/observer identities and filesystem address are recorded; `applicationGeneration:0` means the initial local session, **not a remote transport generation**.
- Emits captured evidence before peer shutdown, including after a test failure. A trace is not exit proof: the process exit result is checked separately.

All three profiled runs retained 63 local phase events, seven queries and seven decoded callbacks from the expected source. There were zero dropped events or observer callback errors. Each emitted nine SharedLog open spans; no provider-resolution or fanout span was emitted in these samples. Missing spans are **not zero-duration measurements**. Shared-fs releases its open-profile callback when Documents.open settles, so it does not supply later per-CID server timing.

## Measurements

Each run used fresh source/observer peers in one local Node process. Stores were in-memory (`directoryConfigured:false`, `nativeBackbone:false` in the emitted observer open span); these are not disk/fsync or WAN benchmarks. The two 5,000-file runs were sequential independent samples, not retries. Profiling itself has overhead, and three samples are not a latency distribution.

| Scope, milliseconds | 64-file control | 5,000-file first | 5,000-file second |
| --- | ---: | ---: | ---: |
| Open call | 237.71 | 370.77 | 220.50 |
| Post-open readiness | 2.29 | 0.59 | 145.25 |
| Root-directory lookup | 11.85 | **2,878.63** | 44.46 |
| Selected-file slot lookup | 4.59 | 69.05 | 12.64 |
| Selected-node read | 4.87 | 4.84 | 5.09 |
| Whole first path lookup/read, including surrounding checks | 26.69 | **2,958.23** | 67.52 |
| Later scan | 63 files / 597.96 | 127 files / 1,183.97 | 127 files / **4,388.09** |

Detailed capture stops after the first read. The iterator facade remains installed, so later scan timings still belong to the instrumented variant even though their individual events are not retained. The second sample's longer scan therefore has no per-query attribution; it cannot be assigned the same cause as the captured initial delay. Warm stable-node reads and whole-path first reads are different scopes, not a cache-speedup comparison. Nested timing spans overlap and must not be added as independent costs.

### First 5,000-file sample: initial seven queries

| Query | Kind / purpose | First next | Next start → decoded callback | Callback → next completion | Close |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Root naming slot | 22.318 | 21.678 | 0.634 | 0.090 |
| 2 | Root node naming revalidation | **2,855.307** | **2,855.038** | 0.270 | 0.033 |
| 3 | File naming slot | 61.708 | 61.501 | 0.207 | 0.028 |
| 4 | File node naming revalidation | 7.052 | 6.967 | 0.085 | 0.025 |
| 5 | Read-node naming refresh | 1.421 | 1.355 | 0.066 | 0.023 |
| 6 | File versions | 1.296 | 1.209 | 0.087 | 0.017 |
| 7 | Content-addressed chunk | 1.696 | 1.635 | 0.062 | 0.023 |

Iterator creation was 0.02–0.11 ms. Both lookup operations and `readNode` have separate existing 5-second budgets; the original combined first-read number was never one per-query deadline. Explicit `remote.from` bypasses cover selection in the installed source; numeric similarity to a default maturity interval is not evidence of maturity waiting.

## Functional and verification gates

Each 5,000-file source held 15,002 documents / 20,480,000 payload bytes. The reader verified 128 distinct files, edits, cross-directory rename, delete, eviction/reread and reconnect refresh. At the scan boundary its cache held four chunks / 16,384 bytes with 124 evictions. Before/after observer residency remained:

- Documents, entry-log records, replication ranges: **0**.
- Blocks: **1**, totaling **178 bytes**, matching the post-open baseline.

Final focused validation passed **80 tests**: 11 cache, 45 query-boundary, 23 profiler, one default/unprofiled 64-file network case. Strict reporting recorded zero retries and zero missing instrumentation; the process exited naturally with code 0. The profiled control and both profiled 5,000-file runs also passed first attempt and exited naturally. Explicit test-file typecheck, ESLint `--no-ignore`, Prettier and library build pass. Full-library and three-OS campaigns were not run for this test-only diagnostic.

During authoring, compilation checks caught query-type narrowing and injected-fixture typing errors; lint caught a `this` alias. These were corrected before network profiling. Intermediate compilation logs remain alongside the final clean logs. There was no failing network campaign hidden by a retry.

## Provenance and reproduction

Runtime: Node 24.13.1, Darwin arm64; unchanged installation at `/private/tmp/peerbit-cohort-integration-20260905`. Peerbit 5.4.2, Documents 15.1.0, SharedLog 16.0.30, RPC 6.1.28, Program 6.0.60, Blocks 4.3.1, Crypto 3.1.6. No install, dedupe, overrides, transport disablement, forced-success exit or dependency-source edit occurred.

Lock SHA-256: `f5c3a197949daccb71ae4fd2585704287d025c83499b2d84d5e0f5b255f924b9`.

Installed runtime and instrumented source hashes:

- Documents `dist/src/search.js`: `ecbfc746621ccd32250a8d2c327fb33d6eb276aef9f49b4a84209bbcd06b8b0b`.
- RPC `dist/src/controller.js`: `6d2f1bde9c61e022abe2076039f536ebe0a17274ed06b7bf7c81b12ba22021e5`.
- Network test: `d91e43fd8710ead2ecb7a624f6ec52194cf19011fe88e8eb14b79e0e67513b10`.
- Profiler adapter: `583e774277963c4294881adca6e0a04b0e5038290d6db2e46724f592d903ddbf`.

```sh
source /Users/marcuspousette/git/peerbit-examples/.envrc
cd /private/tmp/peerbit-sparse-client-20260906
PEERBIT_SHARED_FS_SPARSE_PROFILE=1 PEERBIT_SHARED_FS_SPARSE_FILES=5000 \
  pnpm exec vitest run --config scripts/shared-fs-strict-tests/vitest.config.mjs \
  packages/shared-fs/library/src/__tests__/sparse-query-network.test.ts
```

All artifact paths below have prefix `/private/tmp/peerbit-sparse-profile-20260907-`:

| Suffix | SHA-256 |
| --- | --- |
| `control64.log` | `88b527e1ccfb3a697fcc7c6c19d365510e1e49a9d1582a2664eb5df3ace2d6d6` |
| `5000-first.log` | `c4af2664f5c13002b3125615c9df128a8fa91fb68a6bf2eb7a25442734a19384` |
| `5000-second.log` | `645515ca9611d7570402aaa9a48d0030c10192e1923d81b6ad0ef80f3dde39f8` |
| `5000-first-summary.json` | `2c2e5337ee764516cd05713f576fc0ba0b1d35ff65211fb7ca3f07f2f0d0c5ba` |
| `5000-second-summary.json` | `f95ff70b82f46291831917b608b59ae1f5539b5b5c41cff2ab611bcc39c8cc21` |
| `validation-final.log` | `1507965e5c4f3b27e0404f1d969f6defee9f2bc423bdeacde3c56fba70c1fa0d` |
| `provenance.json` | `b7c27d0bc16e18b5a0a0330c918fc4a11477cef52aca96924058dbcda0ce9411` |

The provenance JSON contains resolved package entry paths and hashes. Final clean validation also includes `root-typecheck-final.log` and `build-final.log`.

## Upstream coordination and next boundary

Both profiled samples were successfully sent to **Investigate bounded shared-log state** on 2026-09-07, with raw paths, the first slow sample's hashes, exact timing limitations, and a request for the next supported source-admission/handler timing boundary. The original sparse-probe request was also successfully delivered that day, superseding its earlier delivery failure.

Upstream confirms no independent demand-pin lease exists: adaptive targeted unreplication remains unsupported, remote pushed updates force replication, and iterator close does not release custody ranges. Finite explicitly sourced `remote.replicate:false` refresh remains the supported bounded-observer pattern. Pin ownership and safe physical reclamation remain separate future work.

The newly verified release keeps Peerbit 5.4.2 and updates Documents to 15.1.1, SharedLog to 16.0.31 and Trusted Network to 6.0.132. It was **not adopted in these measurements**. Release adoption and unchanged N=3/three-OS gates must remain a separate branch/run. The release also does not remove the metadata-authorization gate discussed upstream; source identity and content hashes do not independently authorize remote metadata.

Next useful diagnostic: bounded slow-query summaries for the later scan, paired with supported source-side request timing. The captured gap is not a reason to change cache policy, remove readiness, relax budgets, or claim the cold path fixed.

Follow-up: [the passive transport-boundary report](SPARSE_QUERY_TRANSPORT_RESULTS.md) records a 149 ms exact-ID response-direction gap on this same cohort. It preserves separate request/response chains and does not claim server-handler attribution or explain the later scan tail.
