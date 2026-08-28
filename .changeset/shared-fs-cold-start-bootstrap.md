---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Cold-start bootstrap: a new party opening an existing filesystem reaches a
readable, winner-correct tree in about a second, independent of log size,
then converges to a normal full replica in the background.

- Trusted full replicas periodically materialize their retained HEAD
  state (all naming heads including deletes, all version heads, no
  history, no chunks) into content-addressed segments plus a signed
  manifest (`snapshotWrite()`, automatic publication on long-running
  replicas, `peerbit-fs snapshot` for one-shot use).
- A cold joiner discovers the newest manifest, verifies the inner
  signature against its OWN trust graph, re-hashes every fetched segment
  against the signed manifest, structurally validates every document,
  and serves reads from an in-memory read-through overlay — nothing
  bootstrap-vouched ever enters the log, index, or block store. Segment
  count adapts to snapshot size and fetches route to currently connected
  peers only, so joins stay fast even when the replicator set carries
  dead ex-members; content streams lazily through the existing
  hash-verified remote chunk fetch.
- The overlay retires per document (arrival, removal, or supersession
  proven by a causal descendant); on verified retirement the caches are
  cleared and the resurrection guard arms. Until then the guard stays
  disarmed and garbage collection is gated, and a persisted marker keeps
  both across a crashed bootstrap. Every failure falls back silently to
  a plain join (`bootstrap: { mode: "require" }` throws instead).
- Whole-store conflict/changeset scans throw a typed
  `BootstrapPendingError` while the overlay is active (pass
  `{ allowPartial: true }` for partial-index results). New surface:
  `bootstrapStatus()`, `awaitBootstrapConverged()`, `bootstrap:ready` /
  `bootstrap:converged` events, `bootstrap` and `snapshot` open options.
- Fixed in passing: remote chunk fetch was silently disabled on every
  peer that opened an existing address with default options (a field
  initializer bypassed by deserialization), and empty remote answers are
  now retried within the configured fetch budget instead of failing the
  read while the serving peer is saturated.

Measured (2000 files / 4201 head documents): tree readable 1.2s after
open with the entire log still pending, first lazy content read 1.7s,
background convergence 6.3s — versus 3.1s to readability on a plain join,
a gap that grows linearly with retained history.

Schema note: new bootstrap-manifest document kind; store salt bumped to
/shared-fs/v7. Recreate filesystems and upgrade all peers together.
