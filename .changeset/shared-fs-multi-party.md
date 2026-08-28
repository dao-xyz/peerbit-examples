---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Index-served metadata plane with per-node row caches: flat hot-path latency
under high-churn multi-party workloads.

- Causal references, depths, sizes, content hashes and attribution are
  projected into the document index; head selection and path resolution run
  on index rows and, for warm nodes, entirely on in-memory row caches
  maintained from change events (local writes upsert directly). Reads resolve
  exactly the winning version document.
- Measured on the new multi-party workload benchmark: stat/read of a file
  with 300 retained versions dropped from ~6.5 ms (linear in versions) to
  ~0.3–0.6 ms (flat); listing a directory containing hot files 6.7 ms →
  0.4 ms; 2000-entry directory listing 169 ms → 80 ms; cross-peer write→
  visible latency unchanged at ~16 ms.
- New benchmark suite (multi-party-workload.test.ts) with budgets: hot-file
  version pileup, 100-file write bursts, wide directories, write→visible
  propagation, and 500-file cold joins — medians print to CI for trend
  tracking.
- The dedup-skip witness horizon is configurable per deployment
  (`dedupSkipHorizonMs`, floor 5 minutes; all writers should agree), and GC
  retention clamps to horizon + grace — enabling short-retention
  deployments where files are saved hundreds of times a day.

Schema note: breaking (index projection widened; store salt bumped to
/shared-fs/v5). Recreate filesystems and upgrade all peers together.
