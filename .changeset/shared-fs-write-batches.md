---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Write batches: apply a multi-file change set as one unit with a queryable
changeset identity.

- `writeBatch(entries, { changesetId? })` applies many writes and deletes
  together: parents are resolved once against a shared overlay (missing
  directories are created), chunk-dedup probes and chunk IO are batched
  across the whole set — measured ~40% faster than sequential writes for
  a 100-file change — and unchanged-content entries are skipped for free.
  Batches are serialized per instance, conflicting paths (one entry's
  path under another's) are rejected up front, and directory deletes
  throw EISDIR rather than silently skipping.
- Atomicity contract: per file always — chunks land before the version
  that references them, and a new file's naming event lands last, so a
  crashed or replicated prefix never shows a partially present new file.
  Across entries the batch is not transactional: edits become visible as
  their versions land. Delete events are appended after all creates, so
  intermediate states preserve data (a delete+create rename never
  transiently shows neither file).
- Every applied version and naming event carries the batch's `changesetId`
  (generated when omitted, bounded 1-256 chars at ingest), projected into
  the index and queryable on any peer via
  `versionsByChangeset(changesetId)` — a commit-like handle over
  multi-file changes for tracking and review flows. The identity is
  advisory attribution among trusted writers, and the record is a view
  over retained history that shrinks as GC retires superseded versions.

Schema note: index projection widened; store salt bumped to /shared-fs/v6.
Recreate filesystems and upgrade all peers together.
