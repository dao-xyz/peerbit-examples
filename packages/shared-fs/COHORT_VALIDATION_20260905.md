# Released-cohort integration gates — 2026-09-05

This isolated branch combines current master with the held durability/readiness
upgrade (#300), strict first-failure reporting (#340), trust-cache lifecycle
fence (#344), and result-only allocation cleanup (#345). Combining them here
does not clear their historical failures or merge/release any PR. The original
checkout and existing worktrees remain untouched.

## Release prerequisite

Require upstream's normal publisher to succeed and verify its complete registry
and tag cohort. Record its separate 15-pin consumer result without assuming it
has passed; this repository's install/resolution is an additional consumer gate.
Pin only the verified published cohort, then
run **one plain `pnpm install`** in this new checkout. Do not run dedupe, apply
global overrides, edit dependency code, or upgrade unrelated examples. Verify
actual importer edges, not only package version labels; preserve lockfile and
entry hashes. The earlier empty blocks-interface import and duplicate runtime
class evaluation must be checked in this monorepo's real layout.

Actual prerequisite evidence: publisher 33975676671 succeeded at
`58bb9e09ab6cb41d484e37657e0369c68cc3a06b`. Downstream independently ran the
inspected frozen registry verifier: all 26 exact manifests/internal anchors and
integrity metadata passed with no retries. All 26 remote tags dereference to
that same commit. The separate upstream consumer result was still pending when
this branch performed its own install; no upstream checkout or consumer was
modified. One plain install passed in 37.5 seconds, followed by both builds.
Only the shared-fs library importer changed; the other 25 were unchanged.
Lock SHA256: `f5c3a197949daccb71ae4fd2585704287d025c83499b2d84d5e0f5b255f924b9`.

Upstream subsequently reported its fresh consumer pass: 15 exact pins, 15
package instances and 60 declared pinned dependency edges. Its single install
disabled lifecycle scripts; that result verifies resolution metadata, not
runtime/native behavior or lifecycle safety. The direct roots in that fixture
are not a requirement to add unused production dependencies here.

## Local evidence so far

- Both library and CLI builds passed. Packaging contains 83 library files /
  2,216,951 unpacked bytes and 24 CLI files / 232,162 bytes; tests and diagnostic
  sources remain excluded. These byte counts are not a runtime speed claim.
- All 13 strict-reporter regression cases passed with natural exit 0.
- The released-consumer compatibility test passed all four cases on its first
  execution, zero retries and natural exit 0. Anonymous and root-key shared-fs
  authorization each reject both default target and explicit `target: "none"`
  for nonempty required batches before append/index mutation or fallback. The
  same documents succeed without the requirement, and legacy `writeBatch`
  still works. The per-call error and committed-item array are frozen.
- Real durable-disposal and persistent-multi-writer cleanup now propagates all
  stop errors; it no longer suppresses `clearAll` TypeErrors. Their timeouts,
  retry settings and cleanup order are unchanged.

- Full local library strict gate: 540 passed, 10 skipped, zero retries and zero
  missing instrumentation, natural exit 0 in 70.20 seconds. This includes all
  22 durable-disposal cases, persistent three-writer lifecycle and both
  process-crash recovery cases. CLI: 33 passed, zero retries, natural exit 0
  in 7.56 seconds. These are first executions on this integration cohort.
- In-suite burst timing: 357.80 ms batch versus 700.61 ms sequential median.
  This single pass clears this run's assertion; it is not an attributed speedup
  or a controlled comparison with historical cohorts.
- The new consumer test's first focused typecheck found two test-only typing
  errors: resolved document narrowing and spying on a private backend method.
  Explicit test-only `unknown` casts fix those without runtime changes; the
  original diagnostic is retained separately from product-test evidence.

Runtime module provenance, the fresh three-OS matrix and N=3 full/adaptive
rebaseline remain separate gates. No merge or release is implied by the partial
results above.

## Execution order

1. Build library/CLI and check types, formatting, packaging, strict-reporter
   fixtures and the small required-batching compatibility reproducer.
2. Run the full local library/CLI strict gate once. Preserve the first error,
   retry count, skipped coverage, actual process exit and raw output.
3. Publish the exact validated source as a draft integration PR and execute its
   fresh Ubuntu/macOS/Windows matrix. The receipt, persistent multi-writer and
   process-crash disposal cases use their existing fixed deadlines and no test
   retries. The full-suite reporter also rejects retries elsewhere and exposes
   their original stacks. Do not silently substitute eventual green results.
4. Run the existing N=3 split-plane full control and adaptive diagnostic scenarios
   separately and sequentially, once each, using the same new installation via
   ignored dependency links. Preserve the diagnostic harness, topology, workloads,
   coverage and stability assertions, 20-second stop reply and 15-second natural
   exit deadlines. Keep original old-cohort raw logs immutable. Do not run other
   local suites or benchmarks concurrently with these measurements.

The N=3 experiment remains separate from production shared-fs and cannot prove
that a real sharded namespace has shipped. Successful persisted remote receipts
and offline crash recovery establish different facts from local readiness,
inventory stability, fairness, quotas, throughput and fast cache-miss reads.

## Required batching: explicit compatibility gap

Upstream's new `batching: "required"` is **not currently compatible** with
shared-fs's arbitrary per-entry `canPerform` callback. The independent fast path
also requires `target: "none"` for non-persisted writes; changing target alone
does not solve the authorization restriction. Upstream confirmed this and is
reviewing a separate generic authorization-preserving path. Do not bypass
structural, trust, revocation, or manifest checks, or declare an always-allow
policy to qualify for batching.

The consumer reproducer must use nonempty valid input and show fail-closed
rejection without append, index mutation or sequential fallback. Empty input
is not a capability probe. Preserve legacy writes; do not expose a production
option that is known unable to succeed with the current authorization model.

Future successful integration needs phase-specific commit accounting. A
Documents `not-started` error after shared-fs wrote chunks does not mean the
whole filesystem write did nothing; a naming error may follow committed
versions. Empty `committedItems` under an `indeterminate` outcome is not zero
commit. Preserve immutable ordered evidence, conservative whole-write replay
flags, cache invalidation and content-only repair where versions may have
committed. Required local batching is neither an all-or-none FS transaction nor
a guarantee of one fsync. Persisted remote receipts remain separate durability
proof. No successful required-batching integration is claimed on this branch.
