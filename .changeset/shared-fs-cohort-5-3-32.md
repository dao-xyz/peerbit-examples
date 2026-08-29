---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Upgrade the Peerbit cohort to peerbit 5.3.32 / @peerbit/document 15.0.12
(shared-log 16.0.12, indexer-sqlite3 3.0.17, program 6.0.53, trusted-network
6.0.98) and rebaseline the multi-party scenarios on the new engine. No
shared-fs code change; full suite green (89 library + 9 CLI tests).

Measured on the standing scenarios, old cohort → new cohort, same machine:

- Plain 2,000-file / ~6,200-document cold join: converge 5.14s → 3.48s wall,
  6.48s → 4.40s joiner CPU (~1.5x). The SQLite-batching engine win reaches
  the join at roughly one third of its microbenchmark headline: joiner-side
  INSERT statement time fell 7.33s → 2.21s (3.3x) under identical
  instrumentation, but per-entry signature verification and decode now
  dominate, so the 4.96x index-engine result does NOT translate 1:1.
- 100-file write burst: 137ms → 113ms sequential median, 67ms → 51ms as one
  write batch.
- 60-file remote convergence: 0.6–1.0s → 0.5–0.8s, zero timeout incidents in
  every round on both cohorts.
- Dead-provider scenario (a fully converged replica crashes, then a cold
  peer joins via the live donor): on the old cohort the join was IMPOSSIBLE —
  the program-manifest fetch hit the 30s delivery timeout four times in a
  row (>120s, both with and without the connected-peers fetch routing, which
  never covered the Program.load path). On the new cohort the same join
  opens in 2.1s and converges in 7.4s. The connected-peers routing
  (`remote.from`) is retained: with it disabled the join still succeeds but
  takes 63s to first read, so upstream's reachable-provider prioritization
  removes the unavailability, not the whole penalty.
- Cross-network relayed joins and live write→visible latency: unchanged
  (~11–12s and ~16ms respectively).
