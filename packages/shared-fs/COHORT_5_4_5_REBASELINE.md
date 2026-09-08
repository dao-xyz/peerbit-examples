# Peerbit 5.4.5 downstream rebaseline

## Result and scope

The verified release cohort was adopted on 2026-09-08. One plain install, the
first local builds, strict library/CLI suites and package checks passed. One
separate first-attempt full-mode N=3 capture then passed its persisted barrier
and offline chunk/manifest checks. It still contains a 10-second put stall;
the new profile localizes almost all of that delay before observed settlement.
See the [capture report](./N3_SETTLEMENT_CAPTURE_2026_09_08.md).

This is local Darwin arm64 evidence, not fresh Ubuntu/macOS/Windows acceptance,
adaptive-sharding acceptance, a performance speedup or production release
clearance. Earlier failed samples remain preserved and unexplained. No PR was
pushed, merged or released during this rebaseline.

## Frozen checkout and cohort

Worktree: `/private/tmp/peerbit-profiled-cohort-20260908`, branch
`upgrade/shared-fs-profiled-cohort-20260908`. Measured commit:
`108cb1a84da805fb93aaa85e69c265c1cff3d556`.
The clean merge `968b589d083958932edcd98cce25e9fc5a070871` combines the held
cohort/strict-gate head `8610b1a043667dfda9573914723c1620bbd55972` and test-only
collector head `c65f5eab07ce0f01e480c5a551cd24d664bddb0f`. Their only overlapping
paths, the library manifest and lockfile, were byte-identical. No conflict
resolution was needed. All ten placement workload/helper sources remain equal
to the collector head; production entry sources and strict runner/reporter
remain equal to the held cohort head. The measured commit changes only four
existing direct pins, the generated lockfile and a patch changeset.

Upstream's verified handoff binds release merge
`32c8889257dfcc01b94eafb06c030591719fd895` to successful
[publisher run 34210235918](https://github.com/dao-xyz/peerbit/actions/runs/34210235918),
completed at 09:55:56 UTC. Upstream independently verified 29 publications,
29 matching release tags, registry dependency maps and a fresh consumer
resolution. Those are upstream publication checks, not downstream runtime or
tarball-provenance claims. Source slices are bounded inventory
[#1454](https://github.com/dao-xyz/peerbit/pull/1454), routing correction
[#1456](https://github.com/dao-xyz/peerbit/pull/1456) and bounded settlement
profiling [#1457](https://github.com/dao-xyz/peerbit/pull/1457).

Existing direct library pins are now:

| Package                    | Version |
| -------------------------- | ------- |
| `peerbit`                  | 5.4.5   |
| `@peerbit/document`        | 15.1.5  |
| `@peerbit/program`         | 6.0.63  |
| `@peerbit/trusted-network` | 6.0.136 |

Relevant resolved anchors: Shared Log 16.0.35, Pubsub 5.4.8, Blocks 4.3.2,
Blocks Interface 2.2.1, Stream 5.2.3, Stream Interface 6.0.16, Crypto 3.1.6,
SQLite Indexer 3.0.21, Log 6.2.35, RPC 6.1.31, Native Backbone 0.2.17,
log-rust 1.1.5, shared-log-rust 0.1.8, Indexer Interface 3.1.0, Simple Indexer
1.3.0, Indexer Cache 0.3.0 and unchanged Borsh 6.0.1. No unused verification
fixture dependencies were added and no optional native backend was activated.

Exactly one plain `pnpm install` exited naturally with code 0 in 31.1 seconds,
using Node 24.13.1 and pnpm 10.26.1 with normal existing postinstall hooks and
patches. There was no second install, dedupe, override or dependency-source
patch. All 26 importer keys are unchanged; only the shared-fs library importer
changed. Unrelated workspace deprecation and peer-dependency warnings remain
in the raw log. This work did not reduce the installed dependency tree.

The bounded installed-resolution audit accounts for all 21 expected anchors.
Its static scan covers 203 JavaScript files and 735 edges, with no duplicate
runtime paths in that inspected closure. A separate read-only check of both
computed log-rust imports resolves the same 1.1.5 entry. Nested declared
Crypto/Stream Interface copies under Blocks Interface are not imported by its
emitted JavaScript. These are resolution/source checks, not executed
constructor-identity proof or certification of every computed/third-party import.

## First local gates

Every gate below exited naturally with code 0 on its first invocation. Both
library and CLI strict summaries report `retriedTests: 0` and
`missingInstrumentation: 0`; no first-attempt failure, strict-retry,
`NotStartedError` or unhandled-error report was found. Expected negative-fixture
stderr and untrusted-writer safety notices are not test failures.

| Check                                            | Result                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Library and CLI builds                           | Passed                                                             |
| Strict diagnostic/error regression harness       | 25 passed                                                          |
| Full strict library suite                        | 739 passed, 12 skipped; 57 files passed, eight skipped; 95.20 s    |
| Full strict CLI suite                            | 39 passed in four files; 10.99 s                                   |
| Focused strict TypeScript, ESLint and formatting | Passed                                                             |
| Package contents                                 | Library: 83 files / 2,218,063 bytes; CLI: 24 files / 234,835 bytes |

The 152 additional pure diagnostic tests explain the increase from the previous
587 passing library cases. Live placement scenarios were disabled during this
gate. Unchanged unpacked budgets are 2,750,000 bytes for the library and 325,000
for the CLI. Test collectors remain excluded from published package contents;
the package file counts and sizes are unchanged from the previous rebaseline.

Commands, from this checkout after loading the bot's environment:

```sh
pnpm install
pnpm -r --sort --filter @peerbit/shared-fs --filter @peerbit/shared-fs-cli run build
node --test scripts/shared-fs-strict-tests/regression.test.mjs scripts/shared-fs-strict-tests/error-evidence.test.mjs
env -u CI PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_ENTRY_TIMELINE=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_SETTLEMENT_PROFILE=0 PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PEER_READINESS=0 pnpm --filter @peerbit/shared-fs exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
env -u CI pnpm --filter @peerbit/shared-fs-cli exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
node scripts/verify-shared-fs-package-contents.mjs
```

No retry allowance, deadline, transport or storage policy was changed. The
later N=3 diagnostic uses its preserved historical configuration and is not
counted as a strict-reporter suite.

## Evidence

The lock SHA-256 is
`eb738d37a9b874992038694a7a388b6ec7570f203d6e7d2299b12eb4c1ace86f`.
Local evidence prefix: `/private/tmp/peerbit-profiled-cohort-20260908-`.
These are local retained artifacts, not remote download URLs.

| Suffix                                                  | SHA-256                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `install-first.raw.log`                                 | `a14c5b320317228d8c749b06fb2d2053daf91ca10b9ba43bfd93a5f360519f55` |
| `build-first.raw.log`                                   | `8170a9d3d3a69403859e6f7ca0e4099b1d027f89df12da3d547d51dd76521c31` |
| `diagnostics-first.raw.log`                             | `31d7dc237cb229557c3d79c6b0cc8dcf04cf6c0fa93924b76253243dfbaab18b` |
| `library-first.raw.log`                                 | `e2f1d8ab82beb07b016a118f4f9b8441cc330379fd80d6218a560797dbcb7bfd` |
| `cli-first.raw.log`                                     | `efa4205e355f1a17db92eaad05b2902cf01e59d7a66cc92b6203c499094011f9` |
| `packaging-first.raw.log`                               | `c94338bd443485f5fcd056b8c367f598f147d23e26fc0a8fe746c0bbc1a2f8d4` |
| `typecheck-first.raw.log`, `lint-first.raw.log` (empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `format-first.raw.log`                                  | `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20` |
| `resolution-first.raw.log`                              | `479514ac78524eac1e055fd2194703c4b227ff6c441bf1f47bd0910e3f62707b` |
| `resolution-computed-first.raw.log`                     | `19f5af6d830f671969d8c9a18ad56732b3ec94a0965e0faff0fa57f67c157dc3` |
| `expected-pins.json`                                    | `8bfab604cb732392c8895652617f5377d8f99cecc26414f8e2cd3cce1d37251c` |

Independent merge/resolution, strict-gate and raw-capture reviews found no
material mismatch. All ten embedded benchmark/helper hashes plus the lock
still match measured files after capture. All Git operations and commits used
`peerbit-org`; the original user checkout and its untracked `native.test` were
preserved. This report is a documentation-only addition after measurement.

## Remaining acceptance

Keep the downstream release gate held. Next independent checks are the fresh
unchanged three-OS strict matrix on this cohort and a separately approved,
first-attempt adaptive-mode campaign. Preserve first failures without retries
to green. The present full-mode sample stores all 42 chunks on every surviving
custodian; it does not demonstrate balanced sharding or bounded sparse storage.

Upstream has accepted the pre-settlement stall investigation. No new downstream
probe or rerun is requested yet. The separate metadata confirmation delay,
earlier N=3 timeouts, cold-join mode distribution, writable sparse-client policy
and physical-reclamation safety remain distinct work items. Readiness remains
preflight; awaited persisted delivery is the durability proof before disposal.
Storage-safety metadata alone does not authorize shared-store block deletion.
