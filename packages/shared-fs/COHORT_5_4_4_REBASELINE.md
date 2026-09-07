# Peerbit 5.4.4 downstream rebaseline

## Scope and current gate

The first local installation, build, strict library/CLI suites and package checks
passed on 2026-09-07. This is not cross-platform acceptance or N=3 adaptive
placement clearance. Keep the upgrade draft until those separate gates have
their own first-attempt evidence. No merge or release is implied by this report.

The isolated checkout starts at PR #350's frozen
`f8994e984d451be7f05cb611999d5e90246f464d`, stacked on held PR #349. Only the four
existing library dependency pins, their lockfile resolution, a patch changeset
and this report change. Production code, tests, retry behavior, transport,
timeouts, storage format and replication policy are unchanged.

The earlier 5.4.3 checkout and its installation/publication evidence remain
separate. No 5.4.3 runtime campaign was run. Older failed CI, convergence and N=3
samples are preserved; neither this upgrade nor a later passing run erases them.

## Cohort and dependency scope

The directly used pins are Peerbit 5.4.4, Documents 15.1.4, Program 6.0.62 and
Trusted Network 6.0.135. Relevant transitive versions are Shared Log 16.0.34,
Pubsub 5.4.8, RPC 6.1.30, Stream 5.2.3, Blocks 4.3.2, Log 6.2.34, Native Backbone
0.2.16 and log-rust 1.1.5. Existing Blocks Interface 2.2.1, Stream Interface
6.0.16, Crypto 3.1.6, SQLite Indexer 3.0.20 and Borsh 6.0.1 remain selected.
No unused verification-fixture dependencies were added.

One plain `pnpm install` completed naturally in 28.4 seconds with normal
postinstall hooks, Node 24.13.1 and pnpm 10.26.1 on Darwin arm64. No second
install, dedupe, override or manual dependency-source edit was used. All 26
lockfile importers were compared: only `packages/shared-fs/library` changed.
Unrelated example cohorts were not upgraded. Existing workspace peer-dependency
warnings remain recorded in the installation log.

Independent publication checks passed once for 20 released manifests and nine
unchanged anchors, including complete dependency/optional/peer maps. All 20 live
annotated release tags resolve to `472e5605f252be107b95c951258f85abb5a4648b`.
Saved publisher evidence independently binds attempt 1 of
[run 34153561730](https://github.com/dao-xyz/peerbit/actions/runs/34153561730), the
bot identity, exact checkout and all expected publication/tag outcomes.
These are metadata/tag checks, not independent tarball provenance attestation.

A bounded installed-resolution audit matches all 17 expected anchors. Its
static ESM scan finds no duplicate paths for the inspected runtime closure;
both separately inspected computed log-rust imports select the same 1.1.5 entry.
Nested Crypto/Stream Interface copies under Blocks Interface remain declared
dependencies, but its emitted JavaScript does not import them. This does not
certify the entire dependency graph or every computed/third-party import, and
is not an executed constructor-identity proof. React Native installation bloat
has not been removed.

## First local results

Every command below exited naturally with code 0 on its first invocation.
Library and CLI strict summaries each report zero retried tests and zero missing
instrumentation. Their raw logs contain no first-attempt-failure, strict-retry,
`NotStartedError` or unhandled-error report.

| Check                                      | Result                                                             |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Library and CLI build                      | Both passed; normal emitted-JavaScript compaction                  |
| Strict diagnostic/error regression harness | 25 passed                                                          |
| Full library suite                         | 587 passed, 10 skipped; 50 files passed, seven skipped             |
| Full CLI suite                             | 39 passed in four files                                            |
| Package contents                           | Library: 83 files / 2,218,063 bytes; CLI: 24 files / 234,835 bytes |

Package budgets remain 2,750,000 and 325,000 unpacked bytes respectively. Tests,
benchmark helpers and native binaries remain excluded from these packages.

Executed library coverage includes all 22 durable-disposal cases, the persistent
three-writer lifecycle, both process-crash durability cases and the original
20-edit/500-file convergence scenario. Opt-in N=3 placement and mounted OS smoke
tests are not implicitly covered by the ordinary suite.

The original unprofiled 500-file scenario reported a 2,734.08 ms cold join and
15.76 ms median write-to-visible time. These are single correctness-run samples,
not an isolated performance comparison, a tail-latency estimate or proof that
the historical slow mode is eliminated. Unrelated host build/test activity was
observed before this campaign; no matched-performance window was claimed.

The unchanged commands, from the checkout root, were:

```sh
pnpm install
pnpm -r --sort --filter @peerbit/shared-fs --filter @peerbit/shared-fs-cli run build
node --test scripts/shared-fs-strict-tests/regression.test.mjs scripts/shared-fs-strict-tests/error-evidence.test.mjs
env -u CI pnpm --filter @peerbit/shared-fs exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
env -u CI pnpm --filter @peerbit/shared-fs-cli exec vitest run --config ../../../scripts/shared-fs-strict-tests/vitest.config.mjs --retry=0
node scripts/verify-shared-fs-package-contents.mjs
```

Per-test retries can override Vitest's CLI setting. The unchanged strict runner
preserves the first failure before any retry, and its reporter makes any actual
retry a failing gate even if the later attempt passes. No acceptance deadline
or retry allowance was increased.

## Frozen provenance and evidence

- Lock SHA-256: `dfa07c924f7a9bd49ccc53d6f81b47747f0de0b41ddfb4a409d324d4e7522752`.
- Library manifest SHA-256: `350aeeeff06300127bfb5abcec17b76f9820dfef74ebb7fff53b67c9b65af100`.
- Unchanged library `src/index.ts`: `f9106e131b210f69b56c18a172194053319a5e7a1692af167fda5241ee154942`.
- Unchanged portable workflow: `d40cc6e8bbd5ef0301ffa12ee8ff2d7c5fe8a097dc931420bf620ae280b9e9d9`.
- Upstream frozen publication contract: `6f7277c95289c959fba9446dc9323f00d305a1638e12f6f0da8b983631d4bfa5`.

Local raw prefix: `/private/tmp/peerbit-cohort-5.4.4-20260907-`; the six rows below
have suffix `-first.raw.log`. These paths are local evidence, not remote download
links. Logs remain outside the published packages.

| Label       | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| install     | `e727269a2463563c72a7d9a2ad644581e9e225a1fd7e85629f0d6b09e227d52d` |
| build       | `ef683954e88a4491d2dfa723230d43d342c9f81407e351d858e45bdb78d9ab00` |
| diagnostics | `aa78cee0117e0928570a02b09655605b7213a07509dff982704cf880f040ec53` |
| library     | `ce0d9d4e3648548e302ee39556dbb034326d1b89203924fbec7f4982f330a9d8` |
| cli         | `f2027e79e86271a2085b1aaaf941291c0bba646ad3788cd6d26a34346ac8ad40` |
| packaging   | `c94338bd443485f5fcd056b8c367f598f147d23e26fc0a8fe746c0bbc1a2f8d4` |

Separate `registry-audit.md` and `resolution-report.md` at the same prefix retain
the independent methods, complete evidence hashes and coverage limits.

## Remaining acceptance

Run the unchanged fresh Ubuntu/macOS/Windows matrix and bind its actual checkout
SHA, source/lock hashes, run/attempt and raw per-OS results. Keep the first failures
and do not rerun unchanged failures to obtain green. Package installation and
cross-OS interop remain separate checks. Report CI results against the frozen
head without modifying this measured source merely to update a status table.

Then rebaseline the frozen N=3 full/adaptive experiment separately. Persisted
receipts remain the durability proof; readiness is preflight only. A locally
committed write with `retrySafe: false` must not be blindly replayed. The upstream
same-service-object restart fix is not proof about fresh-process readiness,
post-open missing heads or every shutdown tail. Physical reclamation still fails
closed without caller-exclusive storage metadata, and adaptive production
integration remains gated on independent resilience results.
