---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Artifact ignores: keep derivable, high-churn build trees out of the
replicated store, in two tiers chosen by what can be deterministic.

- Sealed tier (ingest): an immutable `sealedIgnoredNames` list on the
  program — part of the store address, so identical on every peer
  forever — rejects DIRECTORY basenames (default `["node_modules"]`) at
  ingest, replication-order-independent. The canonical catastrophic
  flood bounces fleet-wide before any replication, index, GC or
  snapshot cost is paid. Files with sealed names stay legal; changing
  the sealed list means a new filesystem. Names under `.peerbit-` are
  now reserved for control surfaces at ingest too.
- Policy tier (write/view): a per-open ignore policy — gitignore-subset
  patterns (prefix-closure semantics: every rule is a subtree boundary;
  no negation by design) from open args plus the replicated
  `/.artifactignore` file, read strictly as data with validate-compile-
  swap and last-good fallback. The wrapper rejects writes into ignored
  paths (typed `EIGNORED`), refuses boundary-crossing renames
  (`EXDEV`), skips-and-reports batch entries under `onIgnored: "skip"`,
  hides (or annotates) leaked store entries in views while keeping them
  readable by exact path, and always surfaces boundary-path conflicts.
  The contract, pinned by tests: a peer's mutable policy may influence
  what it WRITES and SHOWS — never what the store ACCEPTS, RETIRES,
  RESURRECTS, or SNAPSHOTS, so divergent configs can only waste
  resources, never corrupt shared state.
- Bootstrap window: snapshot manifests carry the publisher's effective
  patterns as signed advisory rules, installed into a joiner's matcher
  at manifest-accept time — before any content lands — until the real
  rules file is readable.
- New surface: `ignore` and `sealedIgnoredNames` open options,
  `ignoreCheck()` / `ignoreStatus()`, `ignore:rules-changed` /
  `ignore:rules-file-degraded` / `ignore:rules-file-conflict` events,
  `ARTIFACT_IGNORE_STARTER` pattern set, `WriteBatchResult.skipped`,
  `SharedFsEntryInfo.ignoredLeak`.

The machine-local overlay ("divert" mode), hygiene tooling for
already-leaked trees, and mount-tier passthrough are staged follow-ups.
Schema note: program schema extended and manifests widened; store salt
bumped to /shared-fs/v8. Recreate filesystems and upgrade all peers
together.
