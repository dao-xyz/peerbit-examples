# Shared FS v10: Merkle storage replaces v9

Design for owner review; nothing implemented. Code refs: `origin/master`
`6512bd57` (0.14.0), approximate line numbers; measurements: Linux FUSE
`ubuntu-latest`, Peerbit 5.4.6, cited by run id. D1-D22 are the decisions of
the owner review of 2026-09-28.

[MERKLE_STORAGE_V1.md](MERKLE_STORAGE_V1.md) is normative for the codecs, hash
domains, golden vectors, validation and read session. This document says how
those codecs become the only storage format of `@peerbit/shared-fs`, and what
is deleted to get there.

## Decision memo

**Problem.** Editing a large file in place costs time proportional to the file,
not the edit. Linux FUSE, 0.14 code (the commit diet, #368, included), p50:

| Scenario                         |   Mount | Local disk | Source          |
| -------------------------------- | ------: | ---------: | --------------- |
| 4 KiB overwrite in a 32 MiB file |  249 ms |     0.4 ms | run 36450368314 |
| 1 KiB JSONL append, 4 MiB file   | 34.0 ms |     0.4 ms | run 36505083874 |
| 1 KiB JSONL append, 32 MiB file  |  188 ms |     0.3 ms | run 36505083874 |
| SQLite insert transaction, 4 MiB | 82.9 ms |     0.9 ms | run 36505083874 |

PR #368 rounds the 249 ms to an 82 ms writable open, which reads and verifies
the whole file, plus a 161 ms `fsync` commit: one 512 KiB chunk put, a
whole-file SHA-256, re-chunking the whole file and the version put. Section 1.1
has the exact decomposition. Every term except the version put grows with the
file. At 1 GiB the open alone extrapolates to about 2.5 s, and v9 cannot store a
version above about 4 GiB (8,000 chunk ids, `index.ts` ~L5690).

**Why a format change, not more diet.** The remaining O(file) work is required
by the v9 format. `FileVersion.contentHash` is the whole-file SHA-256 and is the
no-op and conflict identity, so every commit re-hashes every byte, and the open
reads the whole file so the commit has those bytes. `FileVersion`'s chunk list
names every chunk, so versions and index rows grow with the file. At 32 MiB,
open, hash and re-chunk alone take about 115 ms, nearly eight times the ~15 ms
the daemon may spend if the sample is to be 8x faster (section 1.3). There are
no production users, so replacing the format costs no migration.

**What v10 fixes.** A Merkle tree of fixed-size leaves (512 KiB by default,
section 2.5; fan-out 256) replaces the chunk list and the whole-file hash.
Writes copy only the path from the changed leaves to the root. Opens verify
lazily. Memory follows dirty bytes, and the 4 GiB ceiling goes.

| 4 KiB overwrite in 32 MiB      | 0.14, measured (B1)               | v10, 512 KiB leaves, projected      |
| ------------------------------ | --------------------------------- | ----------------------------------- |
| Outside the daemon             | 15.9 ms (kernel, harness, IPC)    | unchanged, ~16 ms                   |
| Writable open, other callbacks | 72.5 ms, whole-file verified read | root and rightmost path, ~2 ms      |
| Hash and chunk                 | 43.0 ms, whole file               | one leaf and its path, < 1 ms       |
| Probes, checks, base read      | ~5 ms                             | ~2 ms                               |
| Content puts                   | one 512 KiB chunk, 107.6 ms       | leaf and tree concurrently, 8-12 ms |
| Version put                    | 4.6 ms, grows ~53 B per chunk     | ~3 ms, constant                     |
| Sample                         | 248.5 ms                          | ~31-35 ms (7-8x)                    |

The projection assumes that the put stall of section 1.2 goes away: v10
allocates no whole-file buffer, and M1 stops the benchmark from reading the
whole file back after every sample. Kill point 2 tests that in process. 512 KiB
then sits at the edge of the 8x gate; 256 KiB leaves project about 28-30 ms,
and section 2.5 picks the size.

**What v10 does not fix.**

- **Per-file put cost:** a small file is one leaf and puts what v9 puts;
  `git clone` spends 12.2 ms per file commit in puts (run 36505751493).
- **`getattr` count and latency:** `git status` makes 14,084 calls at 0.204 ms
  (run 36505751493).
- **Kernel time outside the callbacks,** about 4 ms at 4 MiB and 11 ms at 32 MiB
  (run 36450368314).
- **New bytes:** copies, atomic saves and full rewrites stay O(bytes).
- **Retained history:** an append re-puts the tail leaf, about 256 KiB on
  average, kept for `retentionMs` (30 days) as v9 keeps superseded chunks.

Those need upstream put work (asks #17, #18, #23) and mount attribute caching.
Both are independent of v10 and can run in parallel.

**Go/no-go.** M1 builds v10 on one integration branch with three kill points,
cheapest first; thresholds are in section 8:

1. **Put probe:** no product code; it fixes the leaf size, or stops M1 if no
   size fits the put budget.
2. **In-process bench:** stops M1 if v10's open plus commit of a 4 KiB overwrite
   at 32 MiB misses the daemon's ~15 ms budget.
3. **Linux FUSE gate:** 8x on the overwrite and on a mid-leaf append, and no
   regression elsewhere, against 0.14 in the same job.

A failure drops the branch, with the one exception in section 8: 0.14 stays,
and the effort moves to per-put cost. If M1 passes, M2 finishes GC, snapshots
and disposal and ships v10 in one breaking release that deletes v9's content
layer.

**Cost.** Estimated, to be replaced by measured deltas: about 4k new source
lines, 1.4k of them the existing patch builder (#329), and about 2k v9 lines
deleted. No new CLI subcommand, one new `gc` flag, no program option. The
package should fit the existing 2,750,000 B budget
(`scripts/verify-shared-fs-package-contents.mjs` ~L22), because v9's content
layer leaves in the same release; M2 measures it.

**Asked of the owner:** the two questions in section 9, a proposed change to D15
and the D22 choice.

## 1. Measurements

### 1.1 Where the 249 ms goes

Profiled pass B1 of run 36450368314 (profiling overhead 1.00x). Rows nest as the
profiler reports them: sample 248.5 ms, adapter callbacks 237.8 ms, daemon
service 232.6 ms, `localCommit` 160.1 ms. Commit rows are the medians of the 32
MiB writes.

| Per sample                                                           |    ms | Grows with  |
| -------------------------------------------------------------------- | ----: | ----------- |
| Kernel and harness, outside the callbacks                            |  10.7 | file size   |
| IPC transport, 7 callbacks                                           |   5.2 | -           |
| Service outside the commit, mostly the open (`loadWritableSnapshot`) |  72.5 | file        |
| Commit: whole-file SHA-256 (`writeFileInner`, `index.ts` ~L5393)     |  21.4 | file        |
| Commit: re-chunk (`chunkBytes`, ~L1458)                              |  21.6 | file        |
| Commit: `touchChunks` (~L4763), of which the 512 KiB chunk put 107.6 | 110.6 | section 1.2 |
| Commit: version put listing 64 chunk ids                             |   4.6 | chunk count |
| Commit: base load, `reverifyChunks` and the rest                     |   1.9 | -           |

Pass B2 matches within 3 ms (sample 249.4 ms, outside the daemon 12.9 ms).

### 1.2 The put stall

The 107.6 ms put is a stall that follows file size, not a payload cost (upstream
ask #23 reads it as about 0.2 ms per KiB):

| Put payload   | Context                                 | p50                            |
| ------------- | --------------------------------------- | ------------------------------ |
| 512 KiB       | 4 KiB overwrite in 4 MiB (36505751493)  | 7.7 ms (B2), 11.8 ms (B1)      |
| 1-33 KiB tail | 1 KiB append to 32 MiB (36505751493)    | alternately 3-7 and 119-129 ms |
| 512 KiB       | 4 KiB overwrite in 32 MiB (36450368314) | 107.6 ms (B1), 109.9 ms (B2)   |

Every 32 MiB sample allocates whole-file buffers: the open concatenates the
chunks (`readFileVersion` ~L6498), the overwrite benchmark reads the whole file
back, untimed, after every sample
(`scripts/shared-fs-native-mount-benchmark.mjs` ~L698), and an append grows the
mount buffer to 64 MiB and copies it at commit (`mount-backend.ts` ~L652,
~L1509). v10 allocates none of these once M1's
harness verifies only the written range (section 8); whether the stall leaves
with them is what kill point 2 measures.

### 1.3 Budget and projections

**Overwrite.** 8x of 249 ms is 31 ms. Kernel, harness and IPC take about 16 ms
at 32 MiB (B1; 12.9 ms in B2) and v10 does not change them, so the daemon's open
plus commit must fit in about 15 ms. Take away ~2 ms for the open and the other
callbacks, ~2 ms for probes, checks, the base-leaf read and hashing, and ~3 ms
for the version put: `max(leaf put, tree put)` must stay near 8 ms or below.
Leaf and tree go out concurrently and the version last (section 3.1). The open
and base-read terms assume a local leaf get with verification costs about 1 ms,
which kill point 1 measures. The reference is 0.14 in the same job after M1's
harness change, which may lower it, since the per-sample read-back is one of
0.14's whole-file allocations.

**Growth.** The daemon part is flat. The part outside it rises from 12.6 ms at 4
MiB to 15.9 ms at 32 MiB in B1 (6.5 to 12.9 ms in B2), so growth from 4 to 32
MiB is about 1.1-1.3x.

**Append.** 0.14 takes 164-188 ms p50 (runs 36505751493, 36505083874), about 8.5
ms of it outside the daemon. The benchmark's bases are exactly 4 and 32 MiB, so
its appends fill a new 1-33 KiB tail leaf (a ~2.5 ms put) and project about 18
ms. A real log's tail leaf is half full on average: the append reads that leaf
and re-puts about 256 KiB, projecting about 21-24 ms (8-9x). The gate uses a
mid-leaf base (section 8).

**Sequential 8 MiB read.** v10 reads and verifies 16 leaves on demand, where v9
reads 16 chunks and hashes 8 MiB inside the open. Projected within 1.25x;
section 8 says what may be added if not.

## 2. Format

### 2.1 Identity

- **Variant and salt.** Program variant `peerbit_shared_fs_v10_merkle_v1` (D4)
  replaces `peerbit_shared_fs_v9_1` (`index.ts` ~L2232). Entries salt
  `/shared-fs/v10-merkle-v1` replaces `/shared-fs/v9.1` (~L2538). The other
  program fields (id, trust program, `sealedIgnoredNames`) are unchanged. The
  program carries no leaf size.
- **Old filesystems fail loudly.** A 0.14 address fails to open in the v10
  release exactly as a 0.13 address failed in 0.14: its variant does not decode.
  A 0.14 peer cannot attach to a v10 log because the salt differs. There is no
  generation probe, dispatch, typed generation error or read path for old data.
- **Store binding.** `storeBinding = SHA-256(canonical program bytes)`, the
  bytes the address commits to, computed once at open. File versions and naming
  events carry it; bootstrap and changeset manifests put it in their existing
  32-byte `storeId` (`model.ts` ~L520, ~L639), which v9 fills with the program
  id. `canPerformEntry` (~L3636) rejects a mismatch, as it rejects a manifest's
  today (~L3702, ~L3745, ~L10087). A crafted program can copy an id, not a
  binding. Blocks are self-certifying and unbound; trust relations are unbound
  (section 6). There is no envelope and no sub-program id check.

### 2.2 Documents

One `Documents<SharedFsEntry, IndexableSharedFsEntry>` holds every kind:

| Kind                 | Class and variant                                         | Change                                                          |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| Naming               | `NamingEvent`, `shared_fs_naming_event`                   | adds `storeBinding`                                             |
| Bootstrap, changeset | existing manifest classes                                 | `storeId` holds the binding                                     |
| Data block           | `MerkleDataBlockV1`, `shared_fs_merkle_data_block_v1`     | none (`merkle-v1.ts` ~L280)                                     |
| Tree block           | `MerkleTreeBlockV1`, `shared_fs_merkle_tree_block_v1`     | none (~L340)                                                    |
| File version         | `MerkleFileVersionV1`, `shared_fs_merkle_file_version_v1` | adds `storeBinding`, `mode`, `mtime`; drops `legacyWholeSha256` |

The fieldless `MerkleContentEntryV1` (`merkle-v1.ts` ~L35) becomes a subclass of
the fieldless `SharedFsEntry`, so one collection dispatches every kind. An
abstract parent without fields adds no bytes, which the golden wire vectors
check.

**Ingest.** `structurallyValidEntry` (~L2191) checks chunks, naming events and
versions, and accepts every other class. v10 dispatches Merkle values to
`assertMerkleContentEntryV1` (id against content, bounds, canonical shape) and
keeps v9.1's three version checks: mode, `mtime` bound and symlink target size.
`canPerformEntry` adds the store-binding check (section 2.1) and requires
`serialize(value)` to equal the entry's payload bytes, the canonical-bytes rule
that `decodeMerkleContentEntryV1` applies elsewhere. Without this, a `data2:`
row with wrong bytes would satisfy R1-R4's presence probes and fail every read.

### 2.3 File version

`MerkleFileVersionV1` keeps the field order of MERKLE_STORAGE_V1.md, which
lists the v10 fields: `storeBinding: [u8; 32]` after `id`, `mode: u32` and
`mtime: u64` after `size`, and no `legacyWholeSha256`.

- `mode` and `mtime` carry v9.1's semantics unchanged: `mode` is one of
  `0o100644`, `0o100755` or `0o120000` (`SHARED_FS_MODE`, `model.ts` ~L24),
  `mtime` is at most `2^53 - 1` ms, and a symlink is a file node with mode
  `0o120000` whose 1-1023 bytes are its target.
- `contentRoot` is unchanged: SHA-256 over `leafSize`, `size`, `rootLevel` and
  the root hash, recomputed on every ingest. It identifies the bytes only. Mode
  and mtime are metadata, so two heads with equal `contentRoot` hold the same
  content.
- `leafSize` must equal the one leaf size (section 2.5). M1 trims
  `MERKLE_V1_ALLOWED_LEAF_SIZES` (`merkle-v1.ts` ~L22) to it.
- The public `contentHash` becomes `"merkle1:" + base64url(contentRoot)` (D5);
  the prefix tags the value so that callers do not compare it with `sha256sum`.
- A version references one root, so its size (about 0.6 KiB) no longer depends
  on the file, and the 8,000-chunk ceiling disappears. The codec bounds are
  unchanged: wire at most 2 MiB, fan-out 256, depth at most 6, at most 8,000
  parents. With 512 KiB leaves the root level `d` is 0 for one leaf, 1 up to 128
  MiB and 2 up to 32 GiB.

The golden root, sparse-root and tree vectors use 64 KiB leaves, and the
version vector carries `legacyWholeSha256`; M1 regenerates all four at the
chosen size in both languages. The data vector is unchanged. No Merkle version
was ever stored, so nothing depends on the old bytes.

### 2.4 Index row

Keep `IndexableSharedFsEntry` (`model.ts` ~L51) and rename `chunkRefs` (~L77) to
`blockRefs`: a version row lists its root id (or nothing for an all-zero file),
a tree row its children (at most 256), a data row nothing. The row is derived
from the validated document with `merkleRootBlockRefsV1` and
`merkleTreeBlockRefsV1`, never from author input. The `contentHash`, `size`,
`mode` and `mtime` columns are unchanged. New kinds are `merkle-data` and
`merkle-tree`.

### 2.5 Leaf size

One leaf size, fixed before the library prototype from the M1 put probe, with no
knob and no program field (D1, D10). The default is 512 KiB, v9's chunk size: a
new 1 MiB file puts two leaves and a tree in one round of four puts, as v9 puts
two chunks, and a sequential read makes as many gets. The size becomes 256 KiB
only if a churn-free 512 KiB put is above ~8 ms p50 (the budget of section
1.3) and four concurrent 256 KiB puts finish within ~8 ms, so that a 1 MiB
write stays at parity. If neither size fits, M1 stops (kill point 1). Changing
the size afterwards is a format break.

## 3. Write path

### 3.1 One commit routine

`writeFile`, each `writeBatch` entry and mount commits use one routine.
`setMetadata`, `resolveConflict` and naming restores keep v9's copy path
(sections 3.2 and 6).

1. Snapshot the inputs before the first `await`. A mount passes its frozen dirty
   segments, final size, truncation floor, mode and mtime (section 4.3).
2. Lease the base version and every observed head (section 5.1).
3. Run the existing path and expected-node checks
   (`SharedFsExpectedNodeMismatchError` checkpoints).
4. Build with `MerklePatchBuilderV1` (#329, `@internal`) over the base root. It
   reads base trees to compare leaves by position and reads base data only for
   leaves that a patch covers partly.
    - If part of `[floor, min(baseSize, finalSize))` is covered by no patch, the
      commit runs two builds: truncate to `floor`, then apply the patches.
      Otherwise one build covers everything, `O_TRUNC` rewrites included.
    - A dirty set above one build's limits runs as ascending builds over the
      intermediate root. Only the final root is published; intermediate boundary
      trees become orphans for GC.
    - In every build, R1 judges the commit's base version, never an
      intermediate root.
    - A full-coverage write whose base tree is unavailable builds from the empty
      root, so overwriting a damaged file works, as in v9.
5. **No-op.** 0.14's two no-op rules (mount exact-head and library single-head,
   `writeFileInner` ~L5539-5575), unchanged except that `contentRoot` replaces
   `contentHash`. `inheritMeta` (~L1619) also compares `contentRoot`.
6. Drain the sink, recheck the expected node, then put the version, `unique`.
7. R4: recheck presence and re-put from memory (section 3.3).
8. Append the naming event for a new file, or run the `after-version` check;
   advance the caller's base; release leases.

A crash before step 6 leaves only unreachable blocks.

**The sink.** #329's builder awaits `sink.put` leaf by leaf and builds trees
after every leaf, so a sink that put inside `put()` would serialize leaf and
tree puts. The v10 sink's `put()` queues the block and returns. A batch starts
when 128 blocks are queued or when the commit calls `drain()` after the build.
Each batch is one presence probe (R2, then R3 for present blocks) followed by
the puts of the absent blocks, at most `CHUNK_IO_CONCURRENCY` (4, ~L238) in
flight; `put()` waits while a full batch is pending. Trees need not wait for
their children, because only the version makes a block reachable. Changes to
#329: this contract; #339's single leaf hash folded in; an unchanged, fully
covered leaf is reported instead of re-put, so a content-identical build puts
nothing; and every reused base reference is reported to the sink for R1's
probe.

### 3.2 Operations

| Operation                                   | Puts                                            | Base data read        |
| ------------------------------------------- | ----------------------------------------------- | --------------------- |
| Overwrite inside one leaf                   | 1 leaf, `d` trees, version                      | that leaf             |
| Append                                      | last leaf (and new ones), `d` trees, version    | last leaf if partial  |
| Truncate to a smaller size                  | boundary leaf if partial, `d` trees, version    | that leaf             |
| Sparse growth                               | old last leaf if partial, `d` trees, version    | that leaf             |
| `O_TRUNC` and rewrite                       | changed leaves, their paths, version            | none                  |
| Mount save of identical bytes               | version only (new `mtime`)                      | partly covered leaves |
| `writeFile` of identical bytes and metadata | nothing (`unchanged`)                           | none                  |
| `setMetadata`, chmod, utimens               | version only                                    | none                  |
| `resolveConflict`                           | version only                                    | none                  |
| Full `writeFile`, copy, atomic save         | leaves not reused (section 3.3), paths, version | none                  |
| Naming restore of a file                    | the restored closure, resolution version        | the closure           |

The 0.14 rules hold: a mount save that writes identical bytes publishes one
version with a new `mtime` and one `modified` event; a flush, fsync or close
without a write publishes nothing. In v10 that version reuses the root and puts
no block.

**Naming restore** re-puts every locally present block of the restored closure
with dedup `"off"`, as v9 does for chunks (~L8744), then publishes the
resolution version by v9's copy path. R1 does not apply; it stays O(file), as in
v9.

### 3.3 Dedup rules (v9's W1 and W2, carried over)

- **R1, positional reuse.** A block reused from the base by position (an
  untouched subtree, or a leaf rewritten with identical bytes) is not put when
  the commit's base version is a current head of the node or was created within
  the skip horizon (15 days, `DEFAULT_SKIP_HORIZON_MS`, `index.ts` ~L392). One
  batched presence probe covers the reused subtree roots (at most 255 per
  rebuilt tree node, 128 ids per query); a missing root sends its subtree down
  the uncovered-base path. The head clause is question 1 of section 9.
- **Uncovered base.** When the base is neither (a conflicting commit over a
  stale, superseded base), each reused subtree's root goes through R3; an
  unwitnessed subtree is read from the local store and re-put, and if part of it
  is unavailable the commit fails with `EIO` before anything is published.
- **R2, new blocks.** One batched presence probe per 128 blocks
  (`CHUNK_QUERY_BATCH`, ~L257); an absent block is put `unique`.
- **R3, present but not positionally covered** (copies, atomic saves, a save
  split over two commits, shifted content). A batched climb over `blockRefs`,
  one query per level, looks for a version row created within the skip horizon.
  It is bounded: depth 7, 64 referrers per block, 1,024 rows per commit. Found:
  skip. Not found or bound hit: a linked re-put, which refreshes the arrival
  age, as v9's unwitnessed re-put does.
- **R4, W2.** After the version put, recheck every block the build produced from
  caller bytes, whether it was put, skipped by R2 or R3, or reported as an
  identical rewrite, and re-put a missing one from memory, as `reverifyChunks`
  does for every chunk of a write (~L5759).

`dedup: "off"` puts every block. The retention floor
`retention >= skipHorizon + max(grace, 48 h)` (`index.ts` ~L14049) is unchanged;
R1's youth clause and R3 depend on it.

### 3.4 `writeBatch` and partial replicas

`writeBatch` keeps `writeBatchInner`'s order (~L5861) with blocks in place of
chunks; a partial replica puts every block from memory (no R1 or R3); mounts
require a full replica.

## 4. Read and open path

### 4.1 Block source

A `MerkleBlockSourceV1` over `entries`: a local get by `data2:`/`tree2:` id,
then a remote fetch with today's `fetchChunk` budget (~L6440, 10 s). The read
session (`MerkleReadSessionV1`) verifies every block; a missing, corrupt,
wrong-level or wrong-length block fails with `EIO`, never zeros. One
process-wide bounded LRU of verified blocks, keyed by id, is shared by sessions
(blocks are self-certifying). A cached block is never evidence that the store
holds it; R1 to R4 ask the index.

v10 builds no sparse reader. Lazy reads serve full replicas from local blocks; a
partial replica's library reads fetch remote blocks as v9's `fetchChunk` does. A
sparse mount still waits for upstream asks A1 and A2. There is no read-ahead;
section 8's failure rule allows one read-ahead leaf (the next leaf after two
consecutive leaves) if the sequential-read gate fails.

### 4.2 Library reads

`readFile` and `readFileWithVersion` keep head selection and read the chosen
version through a session in pieces of at most 64 MiB. `"exact"` mode throws
`SharedFsVersionUnavailableError` on `EIO`; `"available"` mode keeps its
ancestor walk. Tree verification replaces the whole-file check in
`readFileVersion` (~L6498). No public range-read API is added.

### 4.3 Mount

**Target contract** (`SharedFsMountBackendTarget`, `mount-backend.ts` ~L49-140).
`readVersionForMount` (~L71), which returns a whole verified file in a fresh
buffer, becomes `openVersionRangeForMount(path, versionId)`: a leased session
with `size`, `mode`, `mtime`, `contentHash`, `headVersionIds`,
`read(offset, length)` and `close()`. Symlink reads and conflict virtual paths
use it too. Mount commits call `patchFileForMount(path, patch, options)` instead
of `writeFile`, where `patch` is `{ baseVersionId, segments, size, floor }` and
`options` are the mount's existing commit options (`expectedNodeId`,
`noOpIfHeadVersionIds`, create guards, `mode`, `mtime`). `IgnoreAwareFs`
(`ignore/ignore-fs.ts`) overrides `writeFile` and `setMetadata` but would
inherit `patchFileForMount` unguarded, so it gains a `patchFileForMount`
override that calls `guardWrite` (~L127), and its mount-profile marker (~L157)
covers it. `openVersionRangeForMount` needs no guard, as reads have none today.
The IPC protocol and the native adapter do not change.

**Open state** (`OpenFileState`, ~L276). `buffer`, `borrowedCommitSnapshot` and
the `CommitSnapshot` type (~L339) go. The state gains:

- `base`: version id, root descriptor, lease and read session;
- `dirty`: a map from leaf index to an immutable, sorted array of segments
  `(offset, bytes)`, where `bytes` is a view of a buffer that is never written
  again. A write copies its bytes once, then gives each touched leaf a new array
  that references the old segments and clips overlaps with `subarray`: O(write +
  segments of the leaf), never a leaf-sized copy. FUSE may deliver a large write
  in 4 KiB pieces (the adapter sets no `big_writes`, `native/mount_options.go`),
  so this keeps 128 writes to one leaf linear. Past 64 segments a leaf's array
  is compacted into one leaf-sized buffer, which bounds the array and each
  write's cost;
- `floor`: the lowest size since `base`; base bytes at or above it read as
  zeros.

The operations on that state:

- **Open.** A read-only open resolves the entry and leases the version; it reads
  no data, so a missing block fails the read that needs it, not the open. A
  writable open without `O_TRUNC` also verifies the root and the rightmost
  root-to-leaf path (D11), O(depth) local reads, and fails with `EIO` if either
  is missing. An `O_TRUNC` open verifies nothing, as today
  (`loadWritableSnapshot` ~L1856), and like full-coverage writes succeeds on a
  damaged file.
- **`write`** stays synchronous: it installs the new segment arrays, updates
  `length` (`O_APPEND` uses `length`) and bumps the generation, so the
  append-allocation invariant at `write` (~L2407) holds. There is no background
  prefetch.
- **`read`** plans before its first `await`: dirty segments first, zeros for
  uncovered offsets at or above the floor, the base session for the rest. It
  holds a reference to the session it planned against and then awaits only
  immutable base leaves, so a read stays atomic with respect to `write`,
  `truncate` and commit.
- **`truncate`** (`resizeState`, ~L729) sets `length`, lowers `floor`, and
  replaces the arrays beyond it with clipped ones.
- **Commit** (`localCommit`, ~L1780, same fences and cutoffs) freezes the dirty
  map by reference, passes the frozen segments, `floor`, `length`, mtime and the
  mode (only if changed) to `patchFileForMount`, and starts tracking the lowest
  size since the freeze. On success it drops each leaf whose array is still the
  frozen one, moves `base` to the new version, and resets `floor` to the lowest
  size since the freeze. The old base session closes, and its lease is released,
  when the last read planned against it settles (`MerkleReadSessionV1.close()`
  rejects active reads). On failure it changes nothing: each frozen range is
  still in the map, overwritten by a later write, or cut by a later truncate
  that also lowered `floor`, so no merge rule is needed.
- **Mode and mtime** keep 0.14's rules: a write sets `mtime`, a `setattr` on a
  dirty handle folds into the next commit, and a commit sends the mode only when
  it changed.
- **Permanent failure on `release`** (Linux never retries it): the dirty
  segments, `floor`, final size, mode, mtime, node id, path and base version id
  go to a recovery file under the Peerbit directory, listed in `status --json`
  under `recovery`. Re-applying one is manual; `peerbit-fs recover` waits for a
  user who needs it (D11).

Memory is the dirty map plus the built leaves that R4 may re-put, held until the
version put. A 4 KiB commit to a 1 GiB file holds a few leaves; a full rewrite
through the mount peaks at about twice its bytes, as v9's growth buffer plus its
commit copy does (~L652, ~L1509). A partial write over a base leaf that
disappears after open fails at commit, not at open.

## 5. GC, Guard D, snapshots and disposal

### 5.1 Leases

An in-memory, reference-counted map from version id to root descriptor, held by
mount states, read sessions and in-flight commits, and released by `close()`, a
recovery spill or lifecycle close. No TTL, no persistence. Leases do three
things: leased versions join GC's keep set, leased roots are marked, and Guard D
restores a removed leased version row or a removed block inside a leased root's
tree closure. The 60 s `pinVersions` TTL (~L12495) remains for short library
reads.

### 5.2 Heal, retire, mark

Retirement planning (`planDag`: `keepVersions`, `retentionMs`, `graceMs`, pins,
damaged nodes) is unchanged.

1. **Heal** before retirement, as v9 does (~L14447): walk the root closure of
   every version planned to survive, with a memo. Tree blocks are resolved
   locally or fetched and verified; data blocks get a batched presence probe and
   a verified fetch when missing. An unhealable block marks its node damaged,
   which exempts it from retirement, as today. An unhealable tree also sets
   `sweepBlocked` for the run, since its descendants are unknown.
2. **Retire** and settle, as today.
3. **Mark** after retirement: the union of the closures of every version row
   still present, damaged ones included, plus every leased root, reusing the
   heal memo. A missing data leaf hides nothing. Cost is the order of v9's heal
   pass.

### 5.3 Sweep

- **Candidates:** block rows absent from the mark and older than `blockGraceMs`
  by arrival.
- **Ledger:** v9's two-run ledger (`chunkCandidates`, ~L494; sweep
  ~L14597-14740), renamed `blockCandidates`. Only complete, unblocked runs
  record or execute. The span is `max(minOrphanSpanMs, 48 h)`, applied
  internally with no new option (D12). A stale ledger is handled by v9's
  peer-evidence gate alone (D20). `gc --immediate-sweep`
  (`blockSweep: "immediate"`, ~L14598) skips only the span; the arrival grace,
  the live veto and `sweepBlocked` still apply.
- **Live veto:** delete top-down (trees by descending level, then data). A
  candidate is deleted only if every present referrer returned by `blockRefs`
  was deleted earlier in this run and no leased root reaches it.
- **Delete** through `deleteChunkVerified` (~L13884), generalized to blocks.
- **Report:** deleted tree and data blocks, reclaimed bytes, vetoes, and
  `sweepBlocked` with its cause, in every GC report and in `status`.

### 5.4 Guard D

`guardAgainstLiveRemovals` (~L12613) evaluates a removed chunk at once and
queues only versions and naming events for the 300 ms flush
(`scheduleGuardFlush`, ~L12561). v10 queues removed blocks too and evaluates a
flush in order: versions, then trees by descending level, then data. A removed
block is restored with a linked put when a present row lists it in `blockRefs`,
counting rows restored earlier in the same flush as present, or when it lies in
a leased root's tree closure. A failed lookup restores. The safe failure is
retained garbage. The version branch also restores leased version rows, not
only heads.

### 5.5 Blocked sweeps

An unhealable tree under a present version blocks every block delete, because
deleting the unknown descendants would make a recoverable loss permanent; until
the file is resolved, block reclamation stops on every full replica. The exit is
to resolve the file: a full-coverage overwrite needs no base data, a delete or a
conflict resolution also works, and the broken version then retires normally.
Because normal retirement can take 30 days and 10 versions, a manual
`collectGarbage({ abandonVersionIds })` and
`peerbit-fs gc --abandon-version <id>` retire a superseded broken version early.
It is refused while the version is a head, never waives the retention floor, and
is rechecked in the retiring run. GC never abandons anything by itself (D17).

### 5.6 Snapshots, bootstrap, readiness

Segments still hold naming heads and version heads, never blocks; manifests
carry the store binding in `storeId`. Format numbers are unchanged, since the
variant and salt already separate v10 stores. Joiners read blocks lazily through
the block source. The readiness gate, overlay retirement and Guard D arming keep
their fail-closed order.

### 5.7 Disposal

`captureDisposalClosure` (~L11238) walks each content head's root with a memo,
verifies every tree, and records the resident log hash of every reachable tree
and data block. `deliverDisposalBatch` (~L11383) delivers bounded batches of
data blocks, trees, versions, naming and trust, and the walk fails closed on a
missing block. Block additions and removals bump `disposalContentGeneration`
(~L2321) as naming and version changes do. Cost stays O(live closure).

## 6. Conflicts, metadata, trust

- **Conflicts** keep 0.14's rule: a content conflict needs heads with distinct
  `contentRoot`. Heads that differ only in `mode` or `mtime` merge;
  `conflicts()` (~L6802) lists one version per content, and `headVersionIds`
  lists every head. An explicit-base write also merges heads that hold the
  base's content. Two commits on one base still make two heads even when their
  ranges are disjoint; there is no automatic merge.
- **`resolveConflict` and `setMetadata`** keep v9's copy path (`copyVersion`,
  ~L7031): one constant-size version that points at the selected or visible root
  and parents the heads, with no block IO and no R1 or R3, at any file size.
  `resolveConflict` accepts any version of the node, not only a head, as in 0.14
  (~L6901); the operation leases it, and its row keeps its closure marked
  (section 5.2). This is v9 parity.
- **Trust** is v9.1's (D22). Naming events, versions and manifests are
  store-bound (section 2.1); trust relations are not (question 2).
- **Content equality** leaks at leaf granularity instead of chunk granularity,
  and omitted zero leaves show which leaves are all zeros.

## 7. Deleted in the v10 release

- `FileChunk` and `FileVersion`; the `chunkRefs` column becomes `blockRefs`.
- Chunk IO and whole-file hashing (`touchChunks`, `reverifyChunks`,
  `chunkBytes`, `verifyChunk`, `fetchChunk`, the `chunkSize` option) and the
  8,000-chunk checks.
- The buffer-based mount open state, `readVersionForMount` and the whole-buffer
  target contract.
- The chunk branches of heal, sweep, Guard D, `deleteChunkVerified` and
  disposal.
- The v9 variant and salt, and the public re-export of the Merkle v1 modules.
- `IndexableMerkleEntryV1` and its decoder, `legacyWholeSha256`, the extra leaf
  sizes, and the `fileVersionIndex` golden vector with its Go builder
  (`fileVersionIndexWire`).
- Chunk-specific tests and the three `mount-backend-*` benches, which the
  kill-point-2 bench replaces.

Renamed, without aliases: the GC options `chunkGraceMs` and `chunkSweep`, the
report fields `healedChunks`, `deletedChunks`, `reclaimedChunkBytes` and
`chunkCandidatesRecorded`, the CLI flag `--chunk-grace-hours` and the open
option `remoteChunkFetch` become their `Block` counterparts.

## 8. Milestones

M1 happens on one integration branch; `master` only gains the benchmark's
same-job comparator, the kill-point-2 bench and the harness fixes. Nothing ships
until M2, and v9 content-layer work on `master` pauses meanwhile.

### M1: internal go/no-go

1. **Put probe (kill point 1).** One `workflow_dispatch` run on the Linux
   runner, evidence only: churn-free `Documents.put` of 256 and 512 KiB, singly
   and four at once, and a single local get with verification of each size. It
   fixes the leaf size (section 2.5) or stops M1.
2. **Library prototype:** the version fields and validator, the ingest checks,
   the entry root, the `blockRefs` row, the store binding, the v10 variant and
   salt, the allowed leaf sizes trimmed to the chosen one with the golden
   vectors regenerated; the block source and sink, the builder with its changes,
   R1 to R4, `writeFile`, `writeBatch`, `readFile`, `setMetadata` and conflicts
   on `contentRoot`.
3. **Mount:** the dirty-segment state, lazy opens, `patchFileForMount` with its
   `IgnoreAwareFs` guard, the recovery file. `patchFileForMount` records
   sub-phases in the mount profiler (base read, build and hash, block puts with
   leaf and tree times, version put, R4), and
   `scripts/shared-fs-mount-profile-summary.mjs` joins them as it joins
   `writeFile.*` today.
4. **In-process bench (kill point 2).** An in-repo bench, the shape of the
   evidence folder's `commit-diet-bench.mjs`: `createSharedFsMountBackend` in
   process, open `r+`, a 4 KiB write, `fsync` and release on a 32 MiB file,
   verifying only the written range. It runs on 0.14 and the branch in one job.
   Stop if v10's open plus `fsync` is above ~15 ms p50 or a structural counter
   fails.
5. **Harness:** build 0.14 `master` and the branch head in one job and
   interleave passes (0.14, v10, v10, 0.14). The overwrite verifies the written
   4 KiB after each sample and the whole file once after the loop, as the JSONL
   scenario does, and its offsets are seeded across the file (today they stay
   in leaf 0). The 32 MiB JSONL base moves to 32 MiB + 256 KiB, mid-leaf. Add a
   cold sequential 8 MiB read: a fresh file per sample, written untimed, so
   neither the kernel cache nor the daemon's LRU serves it.

GC is not needed for the gate: blocks may accumulate on the branch.

**Gate (kill point 3)**, Linux FUSE, p50. Each ratio compares the median of both
v10 passes with the median of both 0.14 passes, at least 30 samples per
scenario per pass. `git clone` and `git status` run 3 samples in each of the 4
passes (`devWorkloadSampleCounts`), too few for 1.10x, so they gate at 1.25x.

| Scenario                                    | Pass             |
| ------------------------------------------- | ---------------- |
| 4 KiB overwrite in 32 MiB, seeded offsets   | >= 8x faster     |
| 1 KiB JSONL append, 32 MiB + 256 KiB base   | >= 8x faster     |
| 4 KiB overwrite, 32 MiB / 4 MiB             | <= 1.5x          |
| Sequential 8 MiB cold read                  | <= 1.25x of 0.14 |
| `git clone`, `git status`                   | <= 1.25x of 0.14 |
| Every other benchmark and dev-workload case | <= 1.10x of 0.14 |

"Every other" is stat, read and write of 4 KiB and 1 MiB, small-files-16,
readdir-128, edit-save, the 4 MiB JSONL append and the SQLite transaction. The
append row replaces D21's 4 KiB append: both rewrite only the tail leaf, and it
needs no new scenario.

**Failure rule.** A failed kill point or gate row drops the branch: 0.14 stays,
and the effort moves to per-put cost. The one exception: if the sequential read
is the only failure, add section 4.1's single read-ahead leaf and re-run the
gate. Nothing else is added to pass a gate.

**Structural counters** (library tests, gating): zero whole-file hash bytes on
patch commits; an open reads at most `d + 1` blocks; base data read at most one
leaf per partly covered leaf plus one size-change boundary leaf (shrink or
growth); blocks put at most the changed leaves and their paths; encoded version
size flat from 16 MiB to 1 GiB; an identical `O_TRUNC` rewrite of 32 MiB puts no
block and one version; peak memory of a 4 KiB commit to a 1 GiB file
independent of the file size; built-leaf bytes held for R4 at most the written
bytes. The save split over two commits (`sh -c 'cat src > dst'`) is counted but
not gated. The 512 MiB case is counters plus a manual dispatch (D21).

**Correctness:** TypeScript and Go golden vectors; randomized byte-oracle tests
of write, append, truncate, grow, reopen and read with interleaved commit
failures; a crash after any publication boundary reopens old or new, never
partial; concurrent writers converge to identical head sets; every corruption
fails with `EIO`, and a block row whose bytes do not match its id is refused at
ingest; replay tests reject naming events, versions and manifests from another
filesystem and assert v9 parity for trust; the 0.14 mode, mtime and symlink
suites pass unchanged.

### M2: replace v9 in one release

1. GC: leases, heal and mark, the block ledger with the live veto, the Guard D
   block branch, `sweepBlocked` reporting and `--abandon-version`; GC and CUT
   races never delete a block reachable from a present version or a lease.
2. Snapshots, bootstrap and the disposal closure walk.
3. Delete section 7's list and apply its renames.
4. Strict three-OS CI green; the M1 gate re-run on the final head; the package
   within budget.
5. One breaking minor release. Its changeset says that filesystems created by
   earlier releases no longer open and must be recreated, as 0.14's did. The
   integration branch then merges to `master`.

## 9. Owner decisions (2026-09-29)

1. **R1's head clause changes D15.** D15 kept v9's rule (reuse only a young
   base). With the head clause, the first in-place edit of a file idle for more
   than 15 days puts one leaf and its path, instead of reading the whole file
   locally and re-putting it (about 2,048 puts for a 1 GiB image; v9 re-puts the
   same from its buffer). It also drops 0.14's check that every chunk of a
   reused head is local (~L5664-5668): R1 probes only the reused subtree roots,
   which does not see a missing descendant. The exposure is wider than 0.14's,
   which skips re-puts on a head only for same-bytes and metadata-only writes
   (`writeFileInner` ~L5653): it covers every edit of an idle file that has a
   concurrent descendant elsewhere. A replica holding that descendant may retire
   the base (after `keepVersions`, grace and retention) and sweep blocks that
   the new version reuses before it arrives. Guard D and heal restore them only
   while a replica that still holds them, normally the writer, is online.
   _Decided:_ accept the head clause with the root probe. The fallback was
   D15 as written, which re-puts every idle file on its first in-place edit.
2. **Trust replay (D22).** Shipping before upstream U2 means filesystems created
   before it keep v9's cross-filesystem grant replay until they are recreated.
   _Decided:_ option (b): ship without waiting, relay U2, and recreate
   filesystems once it lands; there are no users to move.

## Review notes

- Put-probe churn arm: not added. After M1's harness change v10 allocates no
  whole-file buffer per sample, and kill point 2 measures its own allocations.
- Golden vectors: regenerated in M1 step 2, not M2, since the leaf size is fixed
  before the library prototype.
- Failure invariant: truncated frozen bytes lie at or above the lowered floor,
  not below it (section 4.3).
- R4 memory: leaves stay copies; the 2x peak of a full rewrite matches v9's
  growth buffer plus commit copy, so it is stated and counted.
