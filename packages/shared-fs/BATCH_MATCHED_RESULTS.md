# Matched overwrite results — 2026-09-05

**All 16 predeclared workers passed once and exited naturally.** Source,
dependency and harness hashes were unchanged before/after. No failed suite or
CI job was rerun. This is not a replacement passing gate for PR #344.

Batching was faster in **12/16** equal-history comparisons, not all of them.
There were two counterexamples on unchanged master and two on the trust fix.
The small sample does **not** establish a consistent trust-fix regression or
prove zero overhead. Keep PR #344's original strict failure and its CI retries
visible; no attribution to upstream, GC, JIT or host noise is established here.

## Scope and provenance

The [predeclared design](BATCH_MATCHED_DESIGN.md) and frozen harness were committed
before measurement at `2ad94eb98d8b7936f82c961a13c0960f3f5bfbfe`.
Baseline production is `b2c9d300deecca240bcd0de322f317fb2475c7f5`; candidate is
PR #344's `7e8a97b63b233017dc65151ef7422b060d1685f2`. Only `src/index.ts` differs
among production source files. This comparison does **not** include the separate
batch-result allocation cleanup.

macOS 26.6.2 (25G83), Darwin 25.6.0, arm64, Apple M3 Pro, 36 GiB; Node 24.13.1,
V8 13.6.233.17-node.40, pnpm 10.26.1, tsx 4.21.0. Start 15:30:56.830 UTC on an
active desktop host; no concurrent benchmark or test suite was started by this
task. The process loader was `node --import tsx`. These fresh-worker timings are
**not directly comparable** with the original parallel Vitest suite's timings.

Identical already-installed cohort on both sources:

- peerbit 5.3.35; document 15.0.16; shared-log 16.0.15;
- program 6.0.56; trusted-network 6.0.102; crypto 3.1.6; Borsh 6.0.1.

No install, dedupe, dependency patch, or upcoming upstream release pin was used.
Lock SHA256: `4a4a8df381f6abb29fa12d604a6c8a1b7c5487ed3df6273b7e069422dc475f57`.
Baseline index SHA256: `ae4022aa6756a86742c3b120f35d6cfa3ae7b9dbef2841393d44e5786592a1e3`.
Candidate index SHA256: `f2e84e8c1fb3be8aaf806baed174c135a94a0e33a0c9344e87d871353bdd72e6`.

Each method uses a separate default `Peerbit.create()` instance and directory-less
local store. Default transports remain enabled, no peers are dialed, and zero
connections are required before/after. Three prior rounds are seeded sequentially
before timing 100 overwrites with the original `round 3 content ${i}` text:
1,790 application bytes, one unique chunk per file. This is neither disk durability
nor multiplayer/mounted-FS/large-file throughput. Root-key cases assert actual
access control, the matching root identity and a warm positive verdict; they
measure **warm own-root authorization**, not trust-graph traversal or revocation.

## Observed local wall times

Four fresh-worker samples per source/auth; no samples removed. S/B are medians
of measured sequential/batch milliseconds. Ratio is the median of each worker's
batch/sequential ratio, not the ratio of the two medians.

| Authorization | Source | Sequential ms | Batch ms | Median B/S | B/S range | Batch faster |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Anonymous | Baseline | 67.41 | 66.33 | 0.971 | 0.960–1.105 | 3/4 |
| Anonymous | Trust fix | 60.14 | 56.22 | 0.932 | 0.894–0.990 | 4/4 |
| Warm root | Baseline | 60.35 | 58.45 | 0.969 | 0.861–1.034 | 3/4 |
| Warm root | Trust fix | 64.00 | 62.55 | 0.974 | 0.853–1.094 | 2/4 |

All eight sequential-first workers had batch < sequential; only four of eight
batch-first workers did. The counterbalanced design exposes an order association,
but does not isolate its cause. Independent peers still share each worker's JIT,
heap and runtime. Do not treat nested/process-wide CPU or GC observations as
exclusive filesystem costs.

| Worker | Auth | Source | First method | Sequential ms | Batch ms | B/S |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1 | Anonymous | Baseline | Sequential | 69.33 | 66.58 | 0.960 |
| 2 | Anonymous | Trust fix | Sequential | 60.61 | 54.22 | 0.894 |
| 3 | Anonymous | Trust fix | Batch | 59.66 | 56.82 | 0.952 |
| 4 | Anonymous | Baseline | Batch | 56.37 | 55.10 | 0.978 |
| 5 | Anonymous | Trust fix | Sequential | 60.95 | 55.61 | 0.912 |
| 6 | Anonymous | Baseline | Sequential | 68.49 | 66.09 | 0.965 |
| 7 | Anonymous | Baseline | Batch | 66.33 | 73.30 | 1.105 |
| 8 | Anonymous | Trust fix | Batch | 58.14 | 57.56 | 0.990 |
| 9 | Warm root | Baseline | Sequential | 60.49 | 52.10 | 0.861 |
| 10 | Warm root | Trust fix | Sequential | 62.08 | 52.98 | 0.853 |
| 11 | Warm root | Trust fix | Batch | 57.81 | 58.61 | 1.014 |
| 12 | Warm root | Baseline | Batch | 66.80 | 64.42 | 0.964 |
| 13 | Warm root | Trust fix | Sequential | 71.12 | 66.48 | 0.935 |
| 14 | Warm root | Baseline | Sequential | 60.20 | 58.63 | 0.974 |
| 15 | Warm root | Baseline | Batch | 56.35 | 58.26 | 1.034 |
| 16 | Warm root | Trust fix | Batch | 65.91 | 72.08 | 1.094 |

Adjacent matched-source ratios (trust/baseline; >1 means trust-fix slower):

| Pair | Auth | First method | Sequential ratio | Batch ratio |
| --- | --- | --- | ---: | ---: |
| 1 | Anonymous | Sequential | 0.874 | 0.814 |
| 2 | Anonymous | Batch | 1.058 | 1.031 |
| 3 | Anonymous | Sequential | 0.890 | 0.841 |
| 4 | Anonymous | Batch | 0.877 | 0.785 |
| 5 | Warm root | Sequential | 1.026 | 1.017 |
| 6 | Warm root | Batch | 0.865 | 0.910 |
| 7 | Warm root | Sequential | 1.181 | 1.134 |
| 8 | Warm root | Batch | 1.170 | 1.237 |

Warm-root batch ratios span 0.910–1.237, and anonymous 0.785–1.031. With four
pairs per authorization and directional disagreement, the trust-fix performance
attribution remains **inconclusive**. This is not a non-regression confidence bound.

## Correctness, shutdown and raw evidence

All 32 method runs independently verified 100 final files, 400 versions, 400
chunks, 105 naming documents, 905 total indexed documents and 100 sole current
heads. Every returned version field was checked against stored history; final
bytes, directory entries, lack of conflicts and fixed historical parents were
verified outside timers. The fixture and final logical content hashes match
across every method/source. Each peer stop resolved and every worker exited 0
without signal/timeout/forced-success exit. No retries.

Fixture SHA256: `88aed48be8b1e298b2c2f1b2a5c5178dc1e83394a513408718980dd471e5cc35`.
Verified content SHA256: `7de9327a872d63674379597e83286811e3332cb92a117327b23cf89ae78eb797`.

Full local evidence is retained at
`/private/tmp/peerbit-performance-20260905/batch-matched-campaign-first/`:

- `predeclared.json`: plan, runtime, dependency edges and source/harness hashes;
  SHA256 `1d7ada8dee1d640ede82578d9d9a2c65ab24157d77223855fab1ad49d6add768`.
- `completed.json`: all raw numeric observations, GC/CPU/ELU/delay, verification,
  source/harness after-hashes and child exits;
  SHA256 `99db7dde125d317afa99b9fbb10e0e3c1a22f09d0fed970e340fc93a18815684`.
- One `.raw.log` and `.json` per worker; each raw SHA256 is in `completed.json`.

The eight harness unit tests pass. A separately labeled four-file authenticated
wiring smoke exited naturally; it is not an extra measured campaign cell.
Initial helper arithmetic and loader-path setup mistakes were corrected before
freezing and preserved in `batch-matched-helper-first-failures.txt` beside the
campaign. None was a Peerbit protocol failure.

## Next bounded work

Keep correctness/work-count assertions separate from a dedicated isolated
performance gate. A plain `batch < sequential median` check in a shared CI suite
does not establish universal batching dominance. Before changing that gate,
review a replacement design that retains explicit latency budgets, full data
verification and no hidden retries; do not silently remove the failing assertion.

Rebaseline remote receipt, N=3 placement and shutdown behavior only after upstream
publishes and verifies its complete new cohort. The earlier N=3 adaptive inventory
instability and shutdown deadline remain unresolved by this local experiment.
