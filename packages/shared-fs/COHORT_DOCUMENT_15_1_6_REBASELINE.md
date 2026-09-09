# Documents 15.1.6 correctness-cohort rebaseline

## Outcome and scope

On 2026-09-09, one plain install, both builds, the strict local library/CLI
suites and package-content checks passed on Darwin arm64. The change adopts
published Documents 15.1.6 and Trusted Network 6.0.137. Peerbit remains 5.4.5,
Shared Log 16.0.35, Program 6.0.63 and RPC 6.1.31.

This is dependency compatibility evidence, not a latency fix, a repeat of the
immutable-admission regression, fresh cross-platform acceptance or adaptive
placement validation. No new N=3, adaptive, soak or profiling campaign was run.
Ordinary suite correctness scenarios, including their existing timing output,
remain part of the unchanged gate and are not a matched performance comparison.
No branch was pushed, PR merged or shared-fs release published in this step.

The [previous full-mode N=3 capture](./N3_SETTLEMENT_CAPTURE_2026_09_08.md)
remains frozen on its original cohort. Its 10,069.337 ms put during concurrent
custodian loss, with only 62.537 ms of observed settlement, is not reclassified
as fixed. Previous failed full/adaptive and targeted samples also remain intact.

## Measured checkout and exact change

Worktree: `/private/tmp/peerbit-immutable-cohort-20260909`, branch
`upgrade/shared-fs-immutable-cohort-20260909`. Clean measured commit:
`bac7b6eff3090cc54dae09ec8b911497a8093b2c`, based on frozen report commit
`8c26b99932dd3c4af18a9855299e33d66b86012c`.

Only the existing library pins `@peerbit/document` 15.1.5 → 15.1.6 and
`@peerbit/trusted-network` 6.0.136 → 6.0.137, their generated lock entries,
and a patch changeset changed before measurement. Production source, tests,
strict runner/reporter, deadlines, transport and replication policy are
unchanged. All 26 lockfile importer keys remain; only the library importer
changed. No unused dependent, optional native backend or new override was added.

Exactly one plain `pnpm install` completed naturally in 20 seconds with
Node 24.13.1 and pnpm 10.26.1, using normal existing postinstall hooks and
patches. Existing unrelated workspace deprecation/peer warnings are retained.
No dedupe, second install or dependency-source patch was performed.

Upstream [#1458](https://github.com/dao-xyz/peerbit/pull/1458) fixes immutable
admission when an empty or same-head response precedes a known conflicting
result. The release is [#1459](https://github.com/dao-xyz/peerbit/pull/1459),
merge `cef80ff755be13993e7076fc62a2ee87a29789a5`, with successful attempt 1 of
[Release run 34318177019](https://github.com/dao-xyz/peerbit/actions/runs/34318177019).
Both exact annotated package tags were independently checked against that
commit; they are unsigned, so this is reference binding, not signature trust.

Complete runtime/optional/peer maps match the frozen source-derived contract,
retained registry captures and freshly installed downstream manifests.
Documents has 22 runtime/one optional/zero peer edges, unchanged from 15.1.5.
Trusted Network has 11 runtime/zero optional/zero peer edges; its sole map
change is the Documents version. Installed source contains the corrected
all-returned-results admission check.

The independent publication checker initially failed by comparing literal
source `workspace:*` selectors with published versions. Its original script,
stdout and a separate record of the original stderr failure are preserved.
The corrected check used
the exact normalized contract and retained upstream registry captures, without
another registry fetch. This was a checker defect, not a publication or
protocol failure. Runtime suites began after the map discrepancy was resolved.

The bounded installed-resolution audit covers 203 JavaScript files and 735
edges with no duplicate runtime paths in the inspected closure. All 21 expected
anchors are accounted for, including the two separately inspected computed
log-rust imports resolving the same 1.1.5 entry. Other computed/third-party
imports and native activation remain outside this metadata/source audit; it
does not claim executed constructor identity or whole-graph certification.

## Local gates

Each gate below passed on its first invocation with natural exit 0. Library
and CLI summaries each report zero retried tests and zero missing
instrumentation. Neither log contains a strict first-failure/retry marker,
`NotStartedError` or unhandled-error report. Expected negative CLI stderr and
untrusted-writer safety notices remain visible.

| Check                                      | Result                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Library and CLI build                      | Passed                                                             |
| Strict diagnostic/error regression harness | 25 passed                                                          |
| Full strict library                        | 739 passed, 12 skipped; 57 files passed, eight skipped; 64.08 s    |
| Full strict CLI                            | 39 passed in four files; 9.17 s                                    |
| Changed manifest/changeset formatting      | Passed                                                             |
| Package contents                           | Library: 83 files / 2,218,063 bytes; CLI: 24 files / 234,835 bytes |

Unpacked package counts/sizes and their 2,750,000 / 325,000 byte budgets are
unchanged. This is not a reduction in installed dependency-tree size.
The library suite includes all 22 durable-disposal cases, both process-crash
durability cases and the persistent three-writer lifecycle. Opt-in placement
and mounted smoke scenarios remain skipped, not implicitly validated.

Coverage distinction: production shared-fs creates its Documents with the
default `immutable: false`; Trusted Network's identity graph also omits
`immutable: true`. Explicit immutable stores here are the separate opt-in
placement worker's metadata and chunk planes. Even that workload does not seed
competing older values under one ID. Upstream supplies the exact response-order
regression and controls; a green downstream suite must not be presented as
reproducing them. This release does not establish partition-wide uniqueness,
repair admitted historical conflicts or change receipt guarantees.

Executed commands from the measured checkout, after loading the bot environment:

```sh
pnpm install
pnpm -r --sort --filter @peerbit/shared-fs --filter @peerbit/shared-fs-cli run build
node --test scripts/shared-fs-strict-tests/regression.test.mjs scripts/shared-fs-strict-tests/error-evidence.test.mjs
env -u CI PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_ENTRY_TIMELINE=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_SETTLEMENT_PROFILE=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PEER_READINESS=0 pnpm --filter @peerbit/shared-fs exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
env -u CI pnpm --filter @peerbit/shared-fs-cli exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
node scripts/verify-shared-fs-package-contents.mjs
```

The unhandled-error suppression flag was checked not to be enabled. No test
deadline, retry allowance or failure expectation was changed.

## Frozen evidence and next steps

Lock SHA-256: `3d7ec1fe38078e727b7cf4d2d36aba35e9888dce91fd29a00b1640e0cb62b79e`.
Library manifest SHA-256:
`884f17d40cf4de4d50184113442aace09d1f6d6eba605567cf80ce1f9a9122db`.
Raw artifact prefix: `/private/tmp/peerbit-immutable-cohort-20260909-`.

| Suffix                                | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `install-first.raw.log`               | `57a79f2748bb670882da7b04ab26fcfafeac96a713f729980b5838d95004fc00` |
| `build-first.raw.log`                 | `20565028ff6c794b818135bbec99f8762e2a8f673d7a66a06699bfe0af5e672e` |
| `diagnostics-first.raw.log`           | `3024716efcaa6f11f8e9b039208bbb9d2e24a12072f47f90bdf8e33005477a67` |
| `library-first.raw.log`               | `644a00aeb3e11ad3df185618a03e85df1a1887f63c3d08f83f8f6808b658fffe` |
| `cli-first.raw.log`                   | `394a32fb6e0dd49a0dbfe5db10fe8c84f2ce0b23ae95e5a9ab06c4da3628c4e4` |
| `packaging-first.raw.log`             | `c94338bd443485f5fcd056b8c367f598f147d23e26fc0a8fe746c0bbc1a2f8d4` |
| `format-first.raw.log`                | `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20` |
| `resolution-first.raw.log`            | `e406fe386c3ba906f95a8fdd98e8a6e18601a2738ac2e5c06b8d43b18c187f32` |
| `resolution-computed-first.raw.log`   | `34f25a60610a22165b9ea96799a32bdb53c36b61cd30120351a31c44a9b6034b` |
| `published-map-binding-first.raw.log` | `5e75422447fa5ba15fcdf4bb327b1e3005ff4e4f59daed9a403632ad37eae178` |

Independent publication method and first checker failure:
`/private/tmp/peerbit-5.4.5-document-15.1.6-20260909-publication-audit.md`.
Frozen upstream contract:
`/private/tmp/peerbit-1459-consumer.yr189g/contract.json`, SHA-256
`d8c0a47abe989985ae91caf2f24417c4a697ee2ac14e7421e4fadf5befcd265a`.
Upstream's wider six-package publication/consumer report is
`/private/tmp/peerbit-1459-release.bmgKTx/POST-PUBLICATION-REPORT.md`; its
constructor/schema/admission controls were not repeated downstream.

All Git/GitHub actions used verified `peerbit-org`. The original user checkout
remains at `5fc804e2ef95af42172c57ffad496d862a489305` with only the existing
untracked `packages/shared-fs/native/native.test`. The previous capture and
targeted failure raw hashes were rechecked unchanged. This report is added
after measurement without altering measured source or frozen reports.

Fresh Ubuntu/macOS/Windows acceptance remains outstanding for this exact
cohort; old CI results are not reused. Keep the release gate held and retain
first failures. Query/RPC profiling #1460 and the separately reported pubsub
timer-rearming fix are not part of these pins. Wait for their verified release
handoff before any targeted latency capture. There is no new downstream
runtime failure to report from this compatibility step and no claim that the
10-second stall, adaptive resilience or bounded sparse storage is solved.
