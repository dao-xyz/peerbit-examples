---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Garbage collection: bounded version history, naming compaction, and real
chunk-byte reclamation — explicit-only, converging, and layered against data
loss.

- `SharedFsHandle.collectGarbage(options)` / `peerbit-fs gc <address>`:
  retires superseded file versions (always keeping current heads, the newest
  `keepVersions`, everything younger than retention/grace, conflict-recoverable
  versions, and in-flight reads), compacts settled per-node naming histories,
  purges fully-deleted nodes after a barrier, and deletes chunks no surviving
  version references. `--dry-run` and `--json` supported.
- Safety stack: winner selection now reads a stored causal depth (validated at
  ingest), so compaction can never change visible winners on any peer; plans
  are pure functions of the local set with a grace-closure fixpoint (deleting
  history can never promote spurious heads); a two-run ledger barrier means a
  freshly-bootstrapped or long-offline replica records candidates and deletes
  nothing; every deletion is head-verified with automatic restore on races;
  and every full replica runs a resurrection guard that re-puts any removed
  chunk still referenced, removed content head, or removed naming head.
- Writers close the dedup/GC race: a chunk put is skipped only when a version
  younger than the skip horizon references it, presence is re-verified after
  every save, and partial replicas always re-put (`dedup: "off"` forces
  re-puts everywhere).
- Restoring a deleted file now carries content (a fresh version reference) and
  fails loudly with ENOENT when nothing recoverable survives, instead of
  resurrecting a contentless ghost. Deletion tombstones are kept forever, so
  purges stay sticky against stale writers.
- Honesty note: version/naming GC reclaims index rows and hot-path CPU;
  metadata deletions each leave a small permanent log tombstone. Only chunk
  GC reclaims real bytes, and by default it lags one run (the safety barrier).

Schema note: breaking (store salt bumped to /shared-fs/v4; stored causal
depth and a chunk reference index were added). Recreate filesystems and
upgrade all peers together.
