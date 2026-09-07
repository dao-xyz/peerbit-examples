# Published cohort rebaseline — 2026-09-07

This candidate starts at held integration PR #346's exact head
`52386c31072931dc42f7b12b683734f59020ace1`. It does not overwrite that PR or the
old-cohort installation and diagnostic logs. Merge and release remain held
until the separate acceptance results are reviewed.

## Adoption and scope

Upstream release PR #1443 merged at
`49bb1efc8f72fc89551f98c62c06aa928c45afc2`; publisher
[34104997349](https://github.com/dao-xyz/peerbit/actions/runs/34104997349)
succeeded on attempt 1. Downstream independently checked all nine release
manifests' complete runtime/optional/peer maps and strong integrity metadata,
and all nine tags resolve to that commit. This is not a tarball-content audit.

Only the library's direct Documents 15.1.2 and Trusted Network 6.0.133 pins
changed. Shared Log resolves transitively to 16.0.32; Peerbit remains 5.4.2.
No unused direct dependencies, global overrides, dependency-source patches or
dedupe were added. One plain `pnpm install` completed naturally in 48.2 seconds
using Node 24.13.1 / pnpm 10.26.1 on macOS 26.6.2, Darwin arm64.
Lock SHA256:
`eac8e78682fc29c70c62c77a73215348de435e5019d7632a99a163b1f07763bd`.

Shared-fs has no `canSearch` constructor policy to migrate. Its existing writer
admission policy is unchanged; this is not a new reader ACL or confidentiality
feature. The positive compatibility test queries one explicit source using
both resolved and indexed requests, checks the returned schema, closes both
iterators, and verifies the observer has no joined entries or replication
ranges. It preserves query and cleanup failures and uses no retries.

## Local results

- Library and CLI builds: passed, natural exit 0.
- Strict-reporter regressions: 13 passed.
- Full strict library gate: 585 passed / 10 skipped, 63.17 seconds; zero retries,
  zero missing instrumentation, natural exit 0. Includes all 22 disposal cases,
  the persistent three-writer lifecycle and both process-crash recovery cases.
- Full strict CLI gate: 39 passed, 10.77 seconds; zero retries, zero missing
  instrumentation, natural exit 0.
- Formatting and the 12 mounted-path/Node-Go IPC harness checks: passed.
- Package-content checks: library 83 files / 2,218,063 unpacked bytes; CLI 24
  files / 234,835 bytes, both within unchanged budgets. The new test is excluded.
- The new query test's first focused run exposed a fixture error: `writeFile`
  returns summary metadata, not the full `FileVersion`. A focused typecheck
  then caught a test-only narrowing error. Both original failures are retained;
  the corrected fixture uses a local source lookup and actual class narrowing.
  Its corrected focused run and typecheck passed, followed by the full gate
  above. These were test-authoring corrections, not protocol retries.

The in-suite burst sample was 149.62 ms batched versus 237.83 ms sequential
median. It is an uncontrolled acceptance observation, not a cohort speedup,
tail-latency estimate or end-to-end mounted-filesystem benchmark.

## Resolution qualification

All 15 cohort names are reached from the six real direct cohort dependencies:
17 installed instances / 61 declared pinned edges, with exact versions and
canonical manifest maps. All 17 checked Borsh consumer namespaces agree at
6.0.1. Blocks-interface has 13 runtime exports, including the frozen unknown
store-safety value. Only shared-fs's importer changed; the other 25 are unchanged.

The strict declaration-path check remains **nonzero**, not an unqualified pass:
hoisted blocks-interface's crypto and stream-interface declarations resolve
to duplicate paths. Neither is imported by its complete emitted JS (index.js
and block.js). This is not an observed duplicate class evaluation, but the
declared-graph exception remains explicit. No dependency code was edited.
The first failure and follow-up classification are retained in
`independent-resolution-audit.json` and `independent-resolution-audit-followup.json`
under the raw evidence prefix below. Unpinned transitive resolution was not
audited; the manifest check is not a whole runtime-graph guarantee.

## Separate N=3 results and outstanding CI

Fresh Ubuntu/macOS/Windows CI must be recorded separately. The frozen N=3
diagnostic source is
`af159b6b9ea854ac8dcec377c28cfe22f361efb1`; only dependency metadata and ignored
links to this installation change. Its seven harness/helper hashes, topology,
workload, receipt budgets, stability assertions and shutdown deadlines remain
unchanged. Historical failures are not erased by the local production-suite
pass, and the experiment is not a shipped sharded filesystem.

Both new first-attempt N=3 runs failed on the first file's metadata receipt:
full at 7,643.362 ms, adaptive at 7,710.011 ms. Both preserved
`PersistedDeliveryError`, `localCommitSucceeded: true`, `retrySafe: false`, and
the nested `No peers found for topic` error. Four preceding chunk puts had
returned, but zero whole files were acknowledged. No settling, join, capacity
change, planned loss, final barrier or offline reopen was reached.

The installed error originates from the initial fresh leader plan being empty
or self-only, not directly from dial. The frozen harness dials without an
explicit metadata receipt-readiness preflight. That is a concrete evidence gap,
not yet a proven root cause or attribution to the release. These earlier
failures do not reproduce or clear the historical later placement/stop failure.

All ten workers stopped once and exited naturally with code 0; exact PIDs were
independently confirmed absent. Adaptive included a fulfilled 10,016 ms handler
stop span, not a hang. All seven harness/helper hashes match the historical
source and reports. Both raw logs and `n3-audit.json` are preserved under the
prefix below, and the failures were sent directly to the upstream task.

Raw local evidence uses the prefix
`/private/tmp/peerbit-cohort-rebaseline-20260907-`: `install-first.log`,
`registry-first.log`, `tags-first.log`, `build-first.log`, `reporter-first.log`,
`library-first.log`, `cli-first.log`, `format-first.log`, `harness-first.log`,
`package-first.log`, and the `query-*` logs. Original checkouts remain untouched.
