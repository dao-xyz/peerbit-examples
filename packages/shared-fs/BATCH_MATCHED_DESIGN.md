# Matched local overwrite experiment — predeclared 2026-09-05

This is diagnostic evidence, not a replacement for a failed test, a release
gate, or a multiplayer/durable-write benchmark. Preserve the failed first
attempts on PR #344; do not retry them until green.

## Question

Does the trust-cache epoch/lifecycle fence materially change local warm
100-file overwrite performance? Independently, does batching outperform
sequential writes on *equivalent* existing histories? The existing CI assertion
compares a later batch overwrite against a median containing one create and two
earlier overwrite rounds, and permits an embedded retry. That is not a matched
comparison.

Compare production source at baseline `b2c9d300deecca240bcd0de322f317fb2475c7f5`
and trust fix `7e8a97b63b233017dc65151ef7422b060d1685f2`. Both use the same
already-installed old dependency cohort and identical lockfile SHA256
`4a4a8df381f6abb29fa12d604a6c8a1b7c5487ed3df6273b7e069422dc475f57`.
No install/dedupe, upstream changes, or tentative release pins are involved.

## Fixed campaign

Run 16 fresh worker processes, sequentially, once each. Eight anonymous and
eight root-key authenticated workers use this same order:

| Within auth group | Source | Method measured first |
| --- | --- | --- |
| 1 | Baseline | Sequential |
| 2 | Trust fix | Sequential |
| 3 | Trust fix | Batch |
| 4 | Baseline | Batch |
| 5 | Trust fix | Sequential |
| 6 | Baseline | Sequential |
| 7 | Baseline | Batch |
| 8 | Trust fix | Batch |

Each worker owns two independent peers, created/stopped sequentially. Both
start with `/project/{a,b,c,d}`, 100 files spread round-robin, and three prior
versions seeded using sequential writes. The measured round overwrites all
100 paths with the exact original workload text `round 3 content ${i}`.
Seed rounds use the corresponding round number. One peer measures sequential
single-file writes and the other a single `writeBatch`, with default options
(no manifest, persisted delivery, or remote peers). Root-key authorization uses
each peer's own public key. All source paths are explicit absolute paths.

Setup and verification are outside timers. Verify every final byte, version
result, live head, and indexed document-type count for both methods. Record wall
time, process CPU, event-loop utilization/delay, bounded GC observations, input
hash, source/dependency provenance, natural child exit and raw output. CPU/GC
metrics cover this process, not just shared-fs; overlapping timing observations
are not additive. Default transports remain enabled but no remote peers are
dialed. No forced-success exit, ignored stop errors, or background suite runs.

Workers have a fixed 240-second cap. Any failure/timeout is retained and marks
the campaign failed; other predeclared independent cells may still run once.
Source/worker/lock hashes must match before and after. Tiny harness validation
may precede the frozen campaign and is labeled separately, not a measured cell.

## Analysis and limits

Report all observations, batch/sequential ratios within workers, and paired
trust/baseline ratios for the same auth and method order (pairs 1–2, 3–4, 5–6,
7–8). Summaries use medians and ranges, without dropping outliers. Four samples
per source/auth is a small diagnostic sample, not a tight regression bound.
If source effects disagree across pairs or are comparable to spread, call the
attribution inconclusive rather than assigning host noise or a patch regression.

Fresh workers remove cross-source process state, but the second peer shares
process JIT/runtime state with the first; method order is counterbalanced.
Identities and generated document IDs differ. This is an active desktop host,
not an isolated performance lab. No cold join, disk durability, network
replication, adaptive balancing, mounted-FS latency, or large-file throughput
claim follows from these measurements.
