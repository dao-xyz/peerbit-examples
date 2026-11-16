---
"@peerbit/shared-fs": minor
---

Every replica now refuses rows outside fixed limits, at ingest (local writes,
replication, repair) and when it installs a snapshot segment, so one buggy or
hostile writer can no longer publish them. Before, ingest checked only that
`causalDepth` was at least 1, so a row at 2^64-1 won its file or name for
good: no write could follow it, since a child's depth no longer fits in a
u64. A chunk list and a name had no bound.

- A name is at most 255 bytes of UTF-8 (`MAX_NAME_BYTES`) and holds no NUL,
  other control character (U+0001-U+001F, U+007F) or lone surrogate, besides
  the rules before (not empty, `.` or `..`, no `/`). `writeFile`,
  `writeBatch`, `mkdir`, `rename`, `resolveNamingConflict` (`move`) and the
  mount backend's create, `mkdir`, `rename` and `symlink` fail before writing
  anything, with the new codes `ENAMETOOLONG` (too long) or `EINVAL`.
- `chunkSize` is an integer from 1 to 4 MiB (`MAX_FILE_CHUNK_SIZE`), else
  `EINVAL`. A version lists at most 65,536 chunks (`MAX_FILE_VERSION_CHUNKS`,
  repeats included, so a sparse file of repeated zero chunks fits) and 8,000
  distinct ones, and exactly as many as some chunk size up to 4 MiB gives its
  size. A write that needs more chunks fails with the new code `EFBIG`; the
  mount backend refuses to grow a file past 65,536 default chunks (32 GiB)
  with `EFBIG`. A read refuses a version whose chunks do not add up to its
  size (`EIO`) before assembling them.
- `causalDepth` is at most 2^53-1 (`MAX_CAUSAL_DEPTH`). Writers saturate
  there, so a child of a row at the cap keeps the cap, still supersedes its
  parent, and ties with concurrent heads on depth (the smaller id wins). A
  depth is still the writer's claim: a row at the cap outranks concurrent
  edits until a write follows it.

This tightens the format without a migration: releases before it accept rows
newer ones refuse, so in a mixed fleet older peers can hold such rows; newer
peers refuse them, still become write-ready and keep syncing everything else.
A snapshot segment holding one fails the joiner's bootstrap. Rows a store
accepted before upgrading stay in it, and chunk sizes between 4 MiB and the
5 MB document cap, which earlier releases accepted, are now refused.
