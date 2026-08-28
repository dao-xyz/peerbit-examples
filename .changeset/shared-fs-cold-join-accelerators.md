---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Cold-join accelerators: roughly halve the time and CPU a new party spends
replicating an existing filesystem.

- Raw exchange-heads sync is enabled on the entries store: senders ship
  raw entry blocks and the receiver batch-computes content addresses and
  batch-verifies signatures (using the wasm verifier when available),
  marking entries preverified. Negotiated per connection with a
  compatible fallback; per-document validation still runs unchanged.
- Trust verdicts are memoized: the trust-graph reachability check ran
  once per replicated document for a handful of distinct signers. Positive
  verdicts live until any trust-graph change flushes the cache (so
  revocations apply immediately); negative verdicts expire after one
  second so writers whose trust relation is still replicating are
  retried.

Measured on the multi-party cold-join benchmark (2000 files, 6200
documents): full convergence 6.0-7.1s before, 3.1s after, with receiver
CPU halved.
