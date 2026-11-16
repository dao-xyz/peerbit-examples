---
"@peerbit/shared-fs": minor
---

Every replica now refuses rows outside fixed limits, at ingest (local writes,
replication, repair) and when it installs a snapshot segment, so one buggy or
hostile writer can no longer publish them. Before, ingest checked only that
`causalDepth` was at least 1, so a row at 2^64-1 won its file or name for
good: no write could follow it, since a child's depth no longer fits in a
u64. A chunk list, a parent list and a name had no bound.

- A name is at most 255 bytes of UTF-8 (`MAX_NAME_BYTES`) and holds no `\`,
  NUL, other control character (U+0001-U+001F, U+007F) or lone surrogate,
  besides the rules before (not empty, `.` or `..`, no `/`). Every library
  path reads `\` as `/`, so no write could reach such a name. `writeFile`,
  `writeBatch`, `mkdir`, `rename`, `resolveNamingConflict` (`move`) and the
  mount backend's create, `mkdir`, `rename` and `symlink` fail before writing
  anything, with the new code `ENAMETOOLONG` (too long) or with `EINVAL`.
  The mount backend no longer reads a `\` in a Linux or macOS name as a
  separator: creating such a name, or renaming from or to one, fails with
  `EINVAL`, and other calls on it with `ENOENT`, where `x\y` used to reach
  `x/y`.
- `chunkSize` is an integer from 1 to 4 MiB (`MAX_FILE_CHUNK_SIZE`), else
  `EINVAL`. A version lists at most 65,536 chunks (`MAX_FILE_VERSION_CHUNKS`,
  repeats included, so a sparse file of repeated zero chunks fits) and 8,000
  distinct ones, and exactly as many as some chunk size up to 4 MiB gives its
  size. A write that needs more chunks fails with the new code `EFBIG`, and
  one with more distinct chunks with `EINVAL` as before (about 3.9 GiB of
  distinct bytes at the default chunk size); the mount backend refuses to
  grow a file past 65,536 default chunks (32 GiB) with `EFBIG`. A read sums
  and hashes a version's chunks before assembling them, so a version whose
  chunks do not match its size or hash fails with `EIO` without being
  allocated.
- A version or naming event lists at most 8,000 parents. A longer list used to
  fail in the indexer after its log append (more than 8,191 parents), so a
  flood of concurrent heads blocked every write to a file with a raw SQLite
  error, and a write reported as failed could show after a reopen. A write
  over more than 8,000 content heads now supersedes the 8,000 best-ranked and
  still shows; later writes supersede the rest (a conflict until then, where
  their bytes differ).
- `causalDepth` is at most 2^53-1 (`MAX_CAUSAL_DEPTH`). Writers saturate
  there, so a child of a row at the cap keeps the cap, still supersedes its
  parent, and ties with concurrent heads on depth, which then order as at
  any equal depth (for names, a head that keeps the node beats a removal;
  then the smaller id wins). A depth is still the writer's claim: a row at
  the cap outranks concurrent edits until a write follows it.

This tightens the format without a migration: releases before it accept rows
newer ones refuse, so in a mixed fleet older peers can hold such rows; newer
peers refuse them, still become write-ready and keep syncing everything else.
A snapshot segment holding one fails the joiner's bootstrap. Rows a store
accepted before upgrading stay in it. A file or directory whose name breaks
the new rules can be read and renamed, but writing, removing or keeping it
under that name fails with `EINVAL` or `ENAMETOOLONG`: rename it first (by
node id, with `resolveNamingConflict`, when its name holds `\`). Newer peers
refuse an older peer's removal of such a node. Chunk sizes between 4 MiB and
the 5 MB document cap, which earlier releases accepted, are now refused.
