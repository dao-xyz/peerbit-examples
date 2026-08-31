---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Unattended resource lifecycle: scheduled GC, naming-compaction unstarving, and snapshot segment reclamation.

- Scheduled garbage collection on full replicas (default every 6 h, jittered,
  first runs spread so fleets never herd; disable with `gc: false`). The
  executing half of the two-run chunk/purge barrier chains automatically once
  candidates mature, anchored to the recording run's start so it can never
  fire early. Gates: bootstrap phase, peer evidence on unverified replicas,
  the manual-run mutex, and a courtesy deferral while a snapshot publishes.
  Failures back off exponentially and surface as gc:error events; successes
  as gc:run. New gcStatus() accessor; scheduled run options are allowlisted
  (dryRun, nowMs, and immediate chunk sweeps are stripped with a warning).
- Naming compaction no longer starves under active heads: the gate is now
  per-head arrival stability (visible locally for namingHeadStabilityMs,
  default 1 h, backdate-proof) instead of every-head author age; retired
  events still stay past namingGraceMs by both stamps. A per-node batch cap
  (namingCompactionBatchLimit, default 500, shallowest-first with the
  fixpoint re-run) bounds upgrade-day delete bursts. The resurrection guard
  gains a split-flush damper so reordered mid-chain deletes from a
  compaction burst cannot plant permanent spurious heads, while genuinely
  lagging peers keep full resurrection protection.
- Superseded snapshot segment blocks are reclaimed after a grace period
  (snapshot.segmentReclaim, default 3 h, floored at the bootstrap staleness
  cap). Only positively recorded own segments are ever deleted, re-verified
  at deletion time against every locally known live manifest, with a
  generation-CAS side-state ledger so CLI and daemon writers never lose
  records and publish intent recorded before any throw-capable step.
  GcReport gains segmentBlocksDeleted and reclaimedSegmentBytes; the CLI gc
  report prints them and status/mount show the schedule state.
- Fixes a pre-existing indexing bug: replicated bootstrap manifests indexed
  with an undefined kind (class initializers are bypassed on
  deserialization), leaving other authors' manifests invisible to kind
  queries on non-author replicas.
