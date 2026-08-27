---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Causal naming: placement and deletion as an append-only event DAG.

Naming is rewritten as per-node immutable naming events with causal parent
pointers, mirroring the content version DAG. The LWW records
(FileRecord/DirectoryRecord/DeleteMarker) are removed; wall clocks no longer
participate in any convergence decision.

- Content writes never touch naming: a concurrent rename can no longer be
  silently reverted by a save.
- Concurrent renames of one node converge to a deterministic winner on every
  peer and are surfaced as a `multi-head` naming conflict.
- Deleting a file records the content heads the delete observed; a concurrent
  edit the delete did not observe is surfaced as `delete-vs-edit` with the
  recoverable version ids — `resolveNamingConflict(nodeId, { type: "restore" })`
  resurrects the file with the edit intact. Concurrent-delete data loss is now
  recoverable instead of silent.
- Concurrent same-name creates keep one deterministic visible winner; the
  shadowed node is surfaced as `duplicate-name` and healed with `move`.
- Unreachable nodes (deleted parents, cross-move cycles) are surfaced as
  `unreachable` and healed with `restore`/`move`.
- New APIs: `namingConflicts(path?)` and `resolveNamingConflict(nodeId,
  action)` with quiescent no-op semantics (concurrent identical resolutions
  converge without ping-pong); `SharedFsEntryInfo.namingConflict` flags
  contested paths.
- Writing over a deleted path creates a fresh node; restoring the old node
  surfaces a deterministic duplicate-name conflict.

Schema note: breaking. The store derivation salt is bumped so 0.2.x and 0.3.x
peers can never attach to the same log; existing filesystems must be recreated
(addresses change) and all peers upgraded together. Mount-level surfacing of
naming conflicts follows in a later release.
