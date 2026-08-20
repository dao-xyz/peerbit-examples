---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Content-addressed chunk storage.

A chunk's id is now derived from its bytes (`chunk:<sha256>`) instead of being
scoped to the version that wrote it. Consequences:

- Identical content is stored and replicated exactly once — across versions of
  one file and across entirely different files. Rewriting a large file with a
  small in-place edit stores only the changed chunks (previously every save
  re-stored the entire file).
- Saving identical content over a single unchanged head is a no-op at the
  library level: no new version, no chunks, nothing to replicate. Explicit
  `baseVersionIds` (conflict flows) still publish.
- Files with repeated identical blocks store that block once and fetch it once
  per read.
- Chunk documents are self-certifying: peers reject any chunk whose bytes do
  not hash to its id at replication time (`canPerform`), and reads verify
  again — a corrupt local copy is healed from remote peers when possible.
- Chunks are sharing-safe (append-only, immortal), which is the precondition
  for garbage collection; a queryable chunk-reference index and the GC design
  itself remain future work.
- Dedup trade-off, documented in the README: chunk ids reveal content
  equality, so anyone with the filesystem address can confirm whether known
  content exists in it.

Schema note: the FileChunk document layout changed (dropped `versionId`/
`index`). Stores written by 0.1.x and peers running 0.1.x are not compatible
with this release; recreate filesystems and upgrade all peers together.
