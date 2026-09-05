# Split-plane placement: released-cohort rebaseline, 2026-09-05

Follow-up: the [N=3 profiling campaign](ADAPTIVE_SHARDING_N3_PROFILE.md) passed
full replication but failed adaptive join stability and cleanup. The N=2
results below remain valid; they must not be generalized to a completed N=3
adaptive or production-filesystem result. Upstream has now received these
findings directly through its Codex task.

## Outcome

**Both unchanged live scenarios passed on their first attempt** after upgrading
the experiment to the newly published Peerbit 5.4.1 cohort. This supersedes the
old-cohort failure status in [the original design/results](ADAPTIVE_SHARDING_DESIGN.md),
without erasing those failures. It is a bounded feasibility result, not production
filesystem integration or proof that all prior liveness bugs are fixed.

This branch pins dependencies for the experiment only. It does not enable
production adaptive replication, implement a new filesystem format, clear the
held upgrade/disposal PR, or authorize a release. The main checkout and held
upgrade worktree were left untouched.

The same test-only two-log model ran sequentially in full and adaptive modes:
24 files, 42 unique 4 KiB chunks, one publisher and 3 → 4 → 3 custodians. Minimum
persisted remote acknowledgements and verified offline custody were N=2. The
production shared-fs default is still N=3, and its namespace remains a different
model. All benchmark code was byte-identical to PR #343's corrected old-cohort
runs; only the dependency manifest/lockfile changed before measurement.

| Final check                                                   | Full control | Adaptive     |
| ------------------------------------------------------------- | ------------ | ------------ |
| Files with successful chunk-first and metadata receipts       | 24           | 24           |
| Renewed exact entries, content / metadata                     | 42 / 24      | 42 / 24      |
| Custodian 2 / 3 / 4 verified offline chunks                   | 42 / 42 / 42 | 25 / 42 / 31 |
| Complete offline manifests per custodian                      | 24           | 24           |
| Minimum verified custodian copies of every chunk              | at least 2   | at least 2   |
| Same identities after crash, zero offline connections         | pass         | pass         |
| Natural exit for every normal stop                            | pass         | pass         |
| Test body duration, including startup/settling/reopen/cleanup | 42.14 s      | 71.82 s      |

The publisher was stopped before every remaining custodian was abruptly killed.
Fresh processes then reopened the same three custodian state directories with
listening/dialing blocked. Every locally indexed chunk was loaded and hash/length
verified, and the union was checked against every expected manifest. The source
process and its retained directory were not used for recovery. No source deletion
or physical reclamation was tested.

Adaptive mode also proved a read of content absent locally: custodian 2 read
file 0 with one local chunk miss, one successful remote return, and complete
manifest/chunk/whole-file verification in **12.95 ms**. Remote replication was
disabled for that query. A further eight repeated reads on custodian 4 included
seven remote returns. These are real remote retrievals, not merely reads with a
fallback option enabled.

No write, test, or campaign retry was used. No deadline was increased, no default
transport disabled, and no forced-success exit substituted for cleanup.

## What the timing and placement show

| Observation                                                        | Full control   | Adaptive    |
| ------------------------------------------------------------------ | -------------- | ----------- |
| Whole-file persisted receipt latency, median of 24 writes          | 125.90 ms      | 139.52 ms   |
| Slowest successful file receipt                                    | 3,193.50 ms    | 3,149.04 ms |
| Final exact-entry renewal barrier                                  | 56.22 ms       | 83.60 ms    |
| Join sampling window until metadata/coverage/stable inventory gate | 5.05 s         | 23.20 s     |
| Adaptive budget-change sampling window                             | not applicable | 15.13 s     |
| Post-loss sampling window until the same gate                      | 12.27 s        | 7.04 s      |

The even-sample median is the mean of sorted observations 12 and 13, not a
nearest-rank p50. These are one-run observations, not reliable p95/p99, a speedup/overhead estimate,
or a benchmark against another filesystem. Files mix 4 KiB and 16 KiB payloads;
chunks and metadata are acknowledged sequentially. Keys/placement are randomized
independently between modes. Total scenario duration includes artificial settling
checks, and adaptive mode has an extra budget-change phase. Do not interpret the
duration ratio as application throughput.

The adaptive join window was **mostly continued content residency changes**, not
a 23-second metadata outage. The first post-write sample was at 17,734.90 ms;
complete metadata was observed at 20,752.26 ms. Every sampled chunk already had
at least two custodian copies. Content inventories kept changing until
38,928.09 ms, with the two-interval stability gate ending at 40,938.53 ms.
Sampling is approximately once per second; it does not prove uninterrupted
coverage between samples or bound a real user's namespace-readiness latency.

The full control's post-loss wait had a different shape: all final content was
already present at the first survivor sample, but custodian 4 still lacked eight
manifests. Complete metadata was first observed **10.26 seconds later**, followed
by the stability intervals. This is visibility lag on an additional peer, not a
failed promise that two remote peers had durably acknowledged the write. A
production filesystem must expose durability and local-view readiness as
separate states rather than promising immediate visibility everywhere.

Lowering custodian 1's soft log-byte target from 75,264 to 56,448 bytes eventually
changed its residency from 14 to 10 chunks (62,510 to 44,650 log bytes), with
intermediate increases and decreases. That demonstrates a response to the budget,
not smooth or instant proportional balancing. After its later loss, the medium
budget survivor held all 42 chunks while the largest-budget survivor held 31.
The fixture therefore does not establish fairness or capacity-proportional
placement. The medium-budget peer's 187,530 log bytes also exceeded its 182,784
byte soft target; these are not hard quotas.

Final custodian residency totaled 98 chunk copies instead of the full control's 126. That is **401,408 versus 516,096 logical payload bytes** across the three
survivors. It excludes metadata, indexes, caches, source data and filesystem
allocation. It is neither a physical disk saving nor a measured reduction in
network traffic. Inventory additions/removals are recorded in the raw events,
but real wire bytes and transfer amplification remain unmeasured.

The next performance questions are controller movement/convergence, bounded
concurrent receipt processing, read caching, and actual transfer cost—not a claim
that adaptive placement is already the fastest choice. One larger peer holding
less than a smaller peer and visible inventory oscillation deserve longer,
real-hardware measurements before policy tuning.

## Dependency provenance and an additional integration concern

The npm registry's published manifests were checked before selecting the cohort.
The fresh worktree is based on `2d9d41e01978b8d6e675ee54b1604ead1bc08e1d` (PR #343).
One plain `pnpm install` completed successfully in 25.5 seconds. No dedupe,
dependency override, manual node_modules edit, or second install was used.
Comparing parsed lockfile importers shows that **only
`packages/shared-fs/library` changed**; the root esbuild movement is key ordering.
Unrelated example cohorts were not upgraded.

| Package                   | Selected/resolved version |
| ------------------------- | ------------------------- |
| peerbit                   | 5.4.1                     |
| @peerbit/document         | 15.0.32                   |
| @peerbit/shared-log       | 16.0.29                   |
| @peerbit/program          | 6.0.59                    |
| @peerbit/trusted-network  | 6.0.130                   |
| @peerbit/pubsub           | 5.4.5                     |
| @peerbit/blocks           | 4.3.0                     |
| @peerbit/blocks-interface | 2.2.0                     |
| @peerbit/crypto           | 3.1.6                     |
| @dao-xyz/borsh            | 6.0.1                     |

Every online and offline worker independently reported the expected actual
Peerbit/document/shared-log/crypto/Borsh versions and resolved entry/package
hashes. This is stronger than checking the root package manifest, but is not a
complete audit of all transitive modules or native binaries.

**Aligned package versions do not guarantee one runtime class identity.** An
expanded read-only resolver/source audit found this extra evaluation path:

```text
library shared-log
  → root blocks-interface 2.2.0
    → its nested stream-interface 6.0.16
      → its nested crypto 3.1.6
```

`blocks-interface/dist/src/index.js` begins with
`import {} from "@peerbit/stream-interface"`. Despite binding no values, it
evaluates that module; its reexports load messages/keys importing crypto and
Borsh. The core library resolves separate stream-interface 6.0.16 and crypto
3.1.6 directories. Both paths share the root Borsh instance.

An initial audit of declared package edges found the nested crypto path, but
checking only direct crypto imports would incorrectly dismiss it as unused.
The indirect empty-import path matters. We have **not** demonstrated nested
instances crossing core protocol APIs or causing a failure; both live runs pass.
Do not claim a duplicate-free runtime, dismiss this integration concern, or
attribute the old failures to it without a reproducer. Ask upstream to review
the unnecessary-looking runtime interface import and test constructor/schema
identity across the actual downstream layout. Do not use dedupe as a workaround.

## Validation and limits

- Both opt-in live modes passed once, with unchanged worker/driver source and
  fixed deadlines; reports have `ok: true` and empty worker diagnostic tails.
- Analysis tests: 12 passed; the two live scenarios are skipped without opt-in.
- Shared-fs library and CLI builds passed; CLI tests: 33 passed in four files.
- Standalone TypeScript checking of the probe and analysis tests, explicit lint,
  and formatting passed. Independent review checked APIs, receipt ordering,
  identity checks, coverage counting and strict cleanup failure propagation.
- No full shared-fs upgrade suite, new cross-OS matrix, mounted workload, N=3
  campaign, hostile-writer test, or real heterogeneous-host campaign is claimed.
  The original PR's CI green result belongs to its older dependency head.

Host: macOS 26.6.2 (25G83), arm64 Apple M3 Pro, 36 GiB RAM; Node 24.13.1;
pnpm 10.26.1. All processes shared this host and disk. Soft budget differences
did not emulate different disk speeds, CPU quotas, failure domains or networks.

## Reproduction and retained evidence

Use the commands in the original design, one separately labeled `full` and
`adaptive` invocation with `--retry 0`. Repository `.envrc` must be loaded for
git/GitHub operations, with `peerbit-org` identity verified. All operations in
this continuation used that identity; no upstream message, merge or release was
performed.

The five measured harness/helper source hashes are unchanged from the original
design. The new lockfile SHA-256 is:

```text
837a6d0b14aa703ed9165ffeaf40e55d1630cc398c55a754bb39dcb7706dbd85
```

Raw logs remain local under `/private/tmp/peerbit-performance-20260905/`, not in
the published package. The benchmark logs contain the full JSON reports and
state-directory paths; do not assume another machine can access these files.

```text
adaptive-rebaseline-5.4.1-install.raw.log
0c8d6d37b1a56b228439ad311e9027583b412aed6b091f2f8b5561bf15a12460
adaptive-rebaseline-5.4.1-full-first.raw.log
7cf9d8bfb1ebd613c08e20f059f1f72c1252c8a5e9ec5ea02d83af5a55534598
adaptive-rebaseline-5.4.1-adaptive-first.raw.log
96239d495fa8c4e18cb2da42d702e5dfe4d1b72ce194302dd19e2ea0f3ff12a1
```

Next gates: review the runtime dependency graph; run strict shared-fs and
cross-OS upgrade checks; extend the experiment to N=3 and separate hosts with
measured transfer bytes and sustained churn. Only then integrate the explicit
new-format metadata/content split with real multiparty authorization, namespace,
uncertain-operation recovery, and disposal semantics from the design.
