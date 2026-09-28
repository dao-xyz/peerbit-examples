---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Store the exec bit and mtime on every file version, and add symlinks. This is
a store break: the program variant is now `peerbit_shared_fs_v9_1` and new
filesystems use the entries salt `/shared-fs/v9.1`, so filesystems created by
earlier releases no longer open. Recreate them; shared-fs has no production
users, so no migration path is kept.

- `FileVersion` gains the required `mode` (`SHARED_FS_MODE.file`,
  `.executable` or `.symlink`: `0o100644`, `0o100755`, `0o120000`) and `mtime`
  (ms) fields, mirrored on index rows. Ingest rejects other modes, an mtime
  above `2^53 - 1`, and a symlink version whose size is outside 1-1023 bytes.
- `WriteFileOptions.mode` and `mtime`. Without them a write keeps the
  best-ranked parent's mode, and its mtime only when the bytes are unchanged
  (otherwise the write time). `writeBatch` and naming restores keep the mode;
  `resolveConflict()` keeps the selected mode, and its mtime only for the
  visible bytes. Both no-op saves also require unchanged metadata, and a write
  of a current head's bytes with new metadata reuses its locally stored chunks
  without chunk IO (unless it sets `chunkSize` or `dedup: "off"`).
- New `setMetadata(path, { mode?, mtime? }, { expectedNodeId? })` on
  `SharedFileSystem`, `SharedFsHandle` and `IgnoreAwareFs` (which rejects
  ignored paths with `EIGNORED`): one chunk-reusing version that merges every
  head with the same bytes.
- A symlink is a file node written with `mode: SHARED_FS_MODE.symlink` whose
  bytes are its target (1-1023 bytes of UTF-8 without NUL; never followed).
  A node never changes between symlink and regular file, nor builds on a base
  version of the other type (`EINVAL`), and `writeBatch` and `setMetadata`
  reject symlinks.
- A content conflict now needs heads with different bytes. Heads that differ
  only in mode or mtime are not a conflict: `conflicts()` lists one version
  per content and `SharedFsEntryInfo.conflict` follows it, while
  `headVersionIds` still lists every head. An explicit-base write also merges
  current heads that hold a base's bytes.
- `SharedFsEntryInfo.mode`, and `updatedAt` is the visible version's mtime for
  files. `SharedFsVersionInfo.mode` and `mtime`, which the CLI's
  `conflicts --json` and `resolve-conflict --json` now print.

Mounts expose these fields; see the mount backend changeset.
