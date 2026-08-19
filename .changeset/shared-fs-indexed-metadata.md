---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Make shared-fs metadata operations scale with the result instead of the store,
and fix the mount write/truncate path.

Performance and scalability:

- Replace the full-store projection (which resolved every document — including
  all file chunk bytes — on every operation) with indexed queries on the local
  document index. `stat`/`readFile` latency is now flat as the store grows
  (measured 84.6 ms → 0.34 ms at 1600 files; per-file write cost during a bulk
  ingest dropped from ~53 ms to ~1 ms), and large files no longer slow down
  unrelated operations.
- Chunk documents are fetched by id (bounded concurrency) and never scanned;
  chunk appends use unique puts and bounded concurrency.
- Mount backend writes use a growable buffer with a logical length (O(n) for a
  sequential write instead of O(n²) copies; a 32 MiB sequential write loop went
  from 813 ms to 8 ms with flat per-write latency).

Replication and durability:

- Filesystem entries and the trust graph now default to a full replica
  (`replicate: { factor: 1 }`) with `keep: "self"`, so every mount serves the
  whole namespace locally and a writer never loses its own files to adaptive
  rebalancing. The CLI's previous cpu-limit replication default was a no-op
  that let the store shard across ≥4 peers, fragmenting the mounted view.
- `readFile` falls back to the newest complete ancestor version when the
  visible head's chunks have not replicated yet, and can fetch missing chunks
  from remote peers (`remoteChunkFetch`, on by default).

Mount correctness:

- New `truncate(pathOrHandle, size)` across the backend, IPC protocol, the
  fuse-native wiring (`truncate`/`ftruncate`), and the Go adapter (which also
  fixes the `fh == ^uint64(0)` sentinel; non-zero truncates previously returned
  ENOTSUP and zero truncates silently committed stale bytes).
- Numeric open flags are parsed with per-platform `O_*` tables (Darwin/Windows
  previously misparsed O_TRUNC/O_APPEND with Linux constants, corrupting
  overwrites through macOS/Windows mounts).
- Flush/fsync/release commits are coalesced per handle and skip minting a new
  version when content is unchanged; mounted saves record the head versions the
  handle was opened from so concurrent remote edits become conflicts instead of
  silent overwrites; rename updates open handles.
- Typed error codes (ENOENT/EEXIST/EISDIR/ENOTDIR/ENOTEMPTY/EINVAL) propagate
  through the backend, IPC, and both adapters instead of collapsing into EIO;
  the IPC server survives client aborts, validates operation names, and the
  client fails fast when a connection drops. Renaming a directory into its own
  subtree is rejected (it previously orphaned the subtree and could hang
  conflict scans).
- `stat(path)` on the library handle and `SharedFsEntryInfo` now expose
  `versionId`/`headVersionIds`/`contentHash`; same-named concurrent creates
  resolve deterministically on every peer.

Dependencies: peerbit 5.3.25, @peerbit/document 15.0.6, @peerbit/program
6.0.51, @peerbit/trusted-network 6.0.92, @peerbit/crypto 3.1.6. Note: the
underlying replication protocol requires all peers of a shared filesystem
address to upgrade together; 0.0.x peers will not exchange replication info
with 0.1.x peers.
