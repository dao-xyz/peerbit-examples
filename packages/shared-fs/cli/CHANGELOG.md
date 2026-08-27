# @peerbit/shared-fs-cli

## 0.3.0

### Minor Changes

- 88694a3: Causal naming: placement and deletion as an append-only event DAG.

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

### Patch Changes

- Updated dependencies [88694a3]
    - @peerbit/shared-fs@0.3.0

## 0.2.0

### Minor Changes

- e0d4d09: Content-addressed chunk storage.

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

### Patch Changes

- Updated dependencies [e0d4d09]
- Updated dependencies [3c6d81c]
    - @peerbit/shared-fs@0.2.0

## 0.1.0

### Minor Changes

- 83ed391: Make shared-fs metadata operations scale with the result instead of the store,
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

    Module-graph integrity: `@peerbit/shared-fs` now re-exports `Peerbit`, and the
    CLI constructs the client through it. Hoisted installs previously gave the CLI
    its own physical copies of the same `@peerbit/*` versions as the library, so
    message classes failed identity checks — peers connected but never exchanged
    replication info. Building the client from the library's module graph removes
    the split; the CLI no longer declares its own `peerbit` dependency and dials
    plain multiaddr strings.

    Dependencies: peerbit 5.3.25, @peerbit/document 15.0.6, @peerbit/program
    6.0.51, @peerbit/trusted-network 6.0.92, @peerbit/crypto 3.1.6. Note: the
    underlying replication protocol requires all peers of a shared filesystem
    address to upgrade together; 0.0.x peers will not exchange replication info
    with 0.1.x peers.

### Patch Changes

- Updated dependencies [83ed391]
    - @peerbit/shared-fs@0.1.0

## 0.0.6

### Patch Changes

- bb5c9ac: Align Shared FS with the Peerbit 5.3.22 runtime cohort and Node.js 22 so trusted-writer keys and log entries share one package identity graph.
- Updated dependencies [bb5c9ac]
    - @peerbit/shared-fs@0.0.6

## 0.0.5

### Patch Changes

- c013794: Update peerbit dependencies to the native-move release (peerbit 5.3.0, @peerbit/document 13.1.0, @peerbit/shared-log 13.2.0). No code changes required — the release is API-compatible; native paths remain opt-in and off by default.
- Updated dependencies [c013794]
    - @peerbit/shared-fs@0.0.5

## 0.0.4

### Patch Changes

- 9b3932d: Refresh shared-fs dependencies to the Peerbit release that keeps
  `@peerbit/libp2p-test-utils` out of production installs.
- Updated dependencies [9b3932d]
    - @peerbit/shared-fs@0.0.4

## 0.0.3

### Patch Changes

- 4bae531: Document and test the lean npm install path using `--omit=peer` so Node.js CLI
  installs avoid optional browser and React Native peer packages.
- Updated dependencies [4bae531]
    - @peerbit/shared-fs@0.0.3

## 0.0.2

### Patch Changes

- 6f2ec6e: Document the published shared filesystem install path, native adapter setup,
  platform prerequisites, and authenticated multi-machine mount flow.
- Updated dependencies [6f2ec6e]
    - @peerbit/shared-fs@0.0.2
