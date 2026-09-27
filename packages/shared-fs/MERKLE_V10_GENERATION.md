# Shared FS v10: the Merkle storage generation and v9 migration

Status: design for owner review. Owner decision of 2026-09-27: "design v10
first". Nothing in this document is implemented, and no v10 format, program,
or migration code should land before it is approved.

[MERKLE_STORAGE_V1.md](MERKLE_STORAGE_V1.md) remains the normative content
format: hash domains, codecs, root descriptor, and golden vectors. This
document specifies how that format becomes a live filesystem generation
("v10") and how existing v9 filesystems move to it. Section 11 lists where it
refines or changes the earlier proposal.

Conventions:

- **A#** is an unverified assumption, with the slice that must check it
  (section 10.3). **D#** is an open decision for the owner (section 10.2).
- **U#** is an upstream (dao-xyz/peerbit) need. Upstream work is out of scope
  for this repository and is relayed through the owner.
- Code references are to master `4a450e70` unless a PR head is named. Line
  numbers are approximate.

## Key decisions

1. **A new generation with a new address.** Program variant
   `peerbit_shared_fs_v10_merkle_v1`, entries salt `/shared-fs/v10-merkle-v1`,
   a fresh program id and trust domain, and a distinct Borsh variant for every
   entry kind. Neither generation can open the other's address or admit the
   other's documents.
2. **Content** uses the merged Merkle v1 codecs unchanged (sparse radix tree,
   fanout 256). The proposed default leaf size is 256 KiB (D1).
3. **Path-copy writes.** A 4 KiB in-place overwrite writes one data block, at
   most `rootLevel` tree blocks, and one constant-size version. The write path
   no longer computes a whole-file SHA-256.
4. **Lazy verified reads.** Mount opens are O(1). A layered byte-range overlay
   replaces the whole-file buffer of an open file.
5. **Dedup.** Untouched subtrees are reused by reference and never re-put.
   Changed blocks are always put. The v9 young-witness skip (W1) survives only
   for root blocks.
6. **GC** traces from retained roots. An unhealable missing tree blocks the
   whole block sweep. Blocks use a two-run ledger with a 48 h minimum orphan
   span, and Guard D climbs reverse edges.
7. **Durability semantics are unchanged.** Mount commits stay local-first and
   disposal stays O(live closure). O(delta) remote full-version durability
   needs U1 and is not claimed.
8. **Migration is an explicit, one-way freeze-and-copy** to a new address. The
   v9 filesystem is retained read-only and a fresh peer verifies the copy. No
   dual write, no automatic upgrade on open.
9. **Rollout** is nine slices behind an opt-in `generation: "v10"`, promoted
   only after the strict three-OS CI and Linux FUSE targets pass.

## 1. Goals, non-goals, and the measured problem

### 1.1 Measured problem

Source: `shared-fs-evidence/mount-profile-runs-20260927/FINDINGS.md` (Linux
FUSE, GitHub `ubuntu-latest`, master `cfa9c2fb` = 0.13.16 plus the #358
profiler, Peerbit 5.4.6). Unprofiled p50s are from the benchmark jobs of runs
36342670967 (4 MiB base) and 36342681298 (32 MiB base). Profiled figures are
from pass B1 of runs 36342675857 and 36342681298.

| 4 KiB overwrite                 | 4 MiB base | 32 MiB base | growth |
| ------------------------------- | ---------: | ----------: | -----: |
| Unprofiled p50                  |    44.9 ms |      481 ms |  10.7x |
| Profiled, per sample            |    50.9 ms |      431 ms |   8.5x |
| Of which local commit           |    31.7 ms |      353 ms |  11.1x |
| Service minus commit (open)     |     ~11 ms |      ~70 ms |    ~6x |
| Local-disk control (unprofiled) |    0.38 ms |           - |      - |

"Service minus commit" is the daemon `ipc.service` p50 minus the
`mount.localCommit` p50; FINDINGS attributes it mostly to the writable open,
which loads and verifies the whole file.

At 32 MiB the `fsync` fence reaches p95 307 ms and max 857 ms. A small commit
costs about 9 ms (the `write 4 KiB` fence is 8.7-9.1 ms, almost all library
`writeFile`). Commit growth of about 11x for 8x the size met the plan's Merkle
decision rule (at least 4x from 4 to 32 MiB).

### 1.2 Why v9 is O(file)

**Writable open.** `openPath` (`mount-backend.ts` ~L1972) calls
`loadWritableSnapshot` (~L1821), then `readVersionForMount` (`index.ts`
~L6072) and `readFileVersion` (~L5898). That fetches every distinct chunk
(`fetchChunk`, each hashed by `verifyChunk`), concatenates them, and hashes the
whole file against `FileVersion.contentHash`. A read-only open does the same
when the target advertises verified reads (`delegatesReadVerification`).

**Commit.** `localCommit` (~L1750) calls `commitNow` (~L1366), which passes the
whole buffer to `writeFileInner` (`index.ts` ~L4920). That function:

- hashes the whole file (`sha256Base64Sync`), then every 512 KiB chunk
  (`chunkBytes` and `new FileChunk`);
- runs W1 (`touchChunks`, ~L4603): `hasDocument` plus a witness index query
  per chunk, and a re-put of every chunk whose only witness is older than the
  15-day skip horizon;
- publishes a `FileVersion` whose `chunkIdsJson` and index `chunkRefs` hold
  all `n` chunk ids;
- runs W2: one more `hasDocument` per chunk.

Every 4 KiB edit therefore hashes the file about four times (twice at open,
twice at commit), issues up to `3n` index operations, writes a version that
grows with `n`, and may re-put every chunk.

### 1.3 Goals

- **G1.** In-place writes (overwrite, append, truncate, sparse growth) commit
  in O(changed leaves x tree depth), through the library and the mount.
- **G2.** Mount opens are O(1); a read is O(returned leaves + depth).
- **G3.** Every v9 safety property holds: fail-closed integrity (`EIO`, never
  invented zeros), per-node causal conflicts, the naming CRDT, the trust model,
  GC never deleting reachable content, the disposal fence, and the
  write-readiness gate.
- **G4.** A one-way, verifiable migration from any v9 filesystem.
- **G5.** Structural work counters prove the complexity change independently
  of timing.

### 1.4 Non-goals

- No v9 wire or behavior change, except S0's behavior-preserving refactor and
  the optional v9-line bridge release (section 8.8).
- No mixed-log rolling upgrade, no dual write, no automatic block-level merge.
- No O(delta) remote full-version durability without U1.
- No compression, encryption, reader confidentiality, or per-file ACL.
- No gain for writers that replace files (temporary file plus `rename`, the
  usual "atomic save"): that creates a new node and stays O(file).
- No change to the fixed per-commit cost (~9 ms; FINDINGS routes it to
  `writeFile` sub-phase profiling) or to metadata transport (0.18 ms per
  callback).

### 1.5 Cost model for a 4 KiB overwrite

Notation: file size `F`, leaf size `B`, `n = ceil(F / B)` leaves, root level
`d` (0 for one leaf, else the smallest `d` with `256^d >= n`). The write stays
within one leaf; crossing a leaf boundary doubles the data terms. Encoded sizes
derived from the codecs: a data block is about `B + 0.1 KiB`; a tree block is
about `0.1 KiB + 32 B x children` (at most ~8.1 KiB); a v10 version is about
0.5 KiB regardless of `F`; a v9 version grows by ~53 B per chunk id.

**v10, 256 KiB leaves (proposed default):**

| File    | Leaves | `d` | Trees on path (children)    | New data | New trees | Docs put | Bytes put | Hashed (library) |
| ------- | -----: | --: | --------------------------- | -------: | --------: | -------: | --------: | ---------------: |
| 4 MiB   |     16 |   1 | root (16): 0.6 KiB          |  256 KiB |         1 |        3 |  ~257 KiB |        ~0.75 MiB |
| 32 MiB  |    128 |   1 | root (128): 4.1 KiB         |  256 KiB |         1 |        3 |  ~261 KiB |        ~0.75 MiB |
| 512 MiB |  2,048 |   2 | root (8), L1 (256): 8.5 KiB |  256 KiB |         2 |        4 |  ~265 KiB |        ~0.76 MiB |

"Docs put" counts the data block, the tree blocks, and the version. "Hashed"
counts the base-leaf verification (`B`), the new leaf twice (`2B`, per #339's
`createWithHash`), and the path trees. Base data fetched is at most one leaf;
path trees are cached after the first commit. Index work is about `2(d + 1)`
presence probes (R2 and R4 in section 3.5) plus the existing node, head, and
namespace checks. **A1:** ingest re-validation of local puts adds about `B` of
hashing, so the total stays O(B).

**Other leaf sizes, same edit (data / new trees / docs):**

| Leaf    | 4 MiB                     | 32 MiB          | 512 MiB         |    Hashed |
| ------- | ------------------------- | --------------- | --------------- | --------: |
| 64 KiB  | 64 KiB / 1 (2.1 KiB) / 3  | 64 KiB / 2 / 4  | 64 KiB / 2 / 4  | ~0.19 MiB |
| 512 KiB | 512 KiB / 1 (0.4 KiB) / 3 | 512 KiB / 1 / 3 | 512 KiB / 2 / 4 |  ~1.5 MiB |

**v9, 512 KiB chunks, same edit:**

| File    | Chunks `n` | Hashed at open | Hashed at commit | Index ops (commit) | Chunks put                     | Version size |
| ------- | ---------: | -------------: | ---------------: | -----------------: | ------------------------------ | -----------: |
| 4 MiB   |          8 |          8 MiB |            8 MiB |           up to 24 | 1, or 8 if base >= 15 days old |     ~0.4 KiB |
| 32 MiB  |         64 |         64 MiB |           64 MiB |          up to 192 | 1, or 64                       |     ~3.4 KiB |
| 512 MiB |      1,024 |          1 GiB |            1 GiB |        up to 3,072 | 1, or 1,024                    |      ~54 KiB |

The v9 open also allocates and copies `F` bytes; the v10 open allocates
nothing proportional to `F`.

### 1.6 Projected latency (a projection, not a measurement)

**A2:** per-document put cost dominates a small commit and is roughly linear
in the document count (small v9 commits put 2 documents in ~9 ms). **A3:**
SHA-256 in the Node runtime runs at 300 MiB/s or more. Under A2 and A3, a v10
4 KiB overwrite commit takes about 12-18 ms at every size above (3-4
documents plus 1-3 ms of hashing), and the writable open costs about a `stat`
plus one lazy leaf read. That projects 20-35 ms per mounted sample, against
45-51 ms (4 MiB) and 431-481 ms (32 MiB) today. The claim is flatness in `F`,
not these absolute numbers; section 9.3 sets gates with margin.

### 1.7 What still costs O(file)

- Full reads (`readFile`, `readFileWithVersion`, reading a whole file through
  the mount) and the `available`-mode ancestor fallback, as in v9.
- Full-content `writeFile(path, bytes)` and `O_TRUNC` plus full rewrite: every
  leaf is hashed, though only changed blocks are put (section 3.3). Also file
  replacement by rename, copies, and an explicit leaf-size change.
- GC heal-and-mark: O(distinct reachable blocks) per GC run, the same order as
  v9's heal pass (`index.ts` ~L13986). No write pays it.
- Disposal and any full-version remote durability proof, until U1.
- Migration and its verifier (one time).

## 2. Generation identity

### 2.1 Identifiers

| Item                   | v9 (today)                                       | v10 (proposed)                                                                                                             |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Program variant        | `peerbit_shared_fs` (`index.ts` ~L2073)          | `peerbit_shared_fs_v10_merkle_v1`                                                                                          |
| Entries salt           | `/shared-fs/v9` (~L2387)                         | `/shared-fs/v10-merkle-v1`                                                                                                 |
| Program id             | random 32 bytes                                  | fresh random 32 bytes (never the v9 id)                                                                                    |
| Trust graph            | `TrustedNetwork({ id })`                         | new `TrustedNetwork` under the new id                                                                                      |
| Entry root             | `SharedFsEntry` (`model.ts` L27)                 | `SharedFsEntryV10` (abstract, fieldless)                                                                                   |
| Content                | `shared_fs_file_chunk`, `shared_fs_file_version` | `shared_fs_merkle_data_block_v1`, `shared_fs_merkle_tree_block_v1`, `shared_fs_merkle_file_version_v1` (merged, unchanged) |
| Naming                 | `shared_fs_naming_event`                         | `shared_fs_v10_naming_event` (same fields)                                                                                 |
| Snapshot pointer       | `shared_fs_bootstrap_manifest`                   | `shared_fs_v10_bootstrap_manifest`                                                                                         |
| Changeset manifest     | `shared_fs_changeset_manifest`                   | `shared_fs_v10_changeset_manifest`                                                                                         |
| Index row              | `shared_fs_indexable_entry`                      | `shared_fs_v10_indexable_entry`                                                                                            |
| Snapshot format        | `SNAPSHOT_FORMAT_VERSION = 1`                    | 2, with the v10 segment entry type                                                                                         |
| Changeset manifest fmt | `CHANGESET_MANIFEST_FORMAT_VERSION = 1`          | 2                                                                                                                          |

v10 makes the merged, fieldless `MerkleContentEntryV1` extend
`SharedFsEntryV10`, so one `Documents<SharedFsEntryV10, IndexableSharedFsEntryV10>`
dispatches every kind. **A4:** re-parenting under another fieldless,
variant-less abstract class keeps every golden vector byte-identical and
abstract dispatch working; the TypeScript and Go golden tests must prove it in
S1. If not, v10 wraps content in a v10 envelope variant instead.

`IndexableSharedFsEntryV10` combines the v9 row columns (`parentId`, `name`,
`deleted`, `causalRefs`, `causalDepth`, attribution, `changesetId`) with the
`IndexableMerkleEntryV1` columns (`blockRefs`, `leafSize`, `rootLevel`,
`treeLevel`, `contentRoot`), and drops `chunkRefs` and `contentHash`. Content
rows use the merged derivation, so `blockRefs` never comes from author input.
New kinds: `merkle-data` and `merkle-tree`.

The program also serializes `defaultLeafSize: u32` as part of the address,
like `sealedIgnoredNames`. New files use it, patches inherit their base's
leaf size, and readers accept any allowed size (D1, D10).

### 2.2 Why every entry kind gets a new variant

Peerbit's log entry metadata (`Meta`: `clock`, `gid`, `next`, `type`, `data`,
per `@peerbit/log` `entry-v0` in the installed cohort) does not bind the log
address, so any reader can re-deliver a signed v9 entry into another log.
Migration preserves node ids (section 8). A replayed, superseded v9 naming
event could therefore become a fresh naming head in v10 and resurrect a deleted
path, and its outer signature would verify if the original writer is trusted
in v10. Distinct variants make every v9 payload undecodable in v10 and the
reverse. Manifests also bind `storeId`, which differs because the program id is
fresh. Replaying self-certifying Merkle blocks is harmless.

### 2.3 How a peer tells v9 from v10

- **The address is authoritative.** The stored program's first Borsh variant
  is `peerbit_shared_fs` or `peerbit_shared_fs_v10_merkle_v1`. The entries
  `Documents` id is a serialized program field, so neither program can attach
  to the other's log.
- **`openSharedFs({ address })`** (`index.ts` ~L14633) reads the stored
  program's variant first and dispatches to `SharedFileSystem.open` or
  `SharedFileSystemV10.open`. An unknown variant throws
  `SharedFsUnsupportedGenerationError` (code `EINVAL`, carrying `generation`
  and `minimumPackageVersion`). **A5:** the program block's variant can be
  read without a full open (S1).
- **`handle.generation`** is `"v9" | "v10"`, printed by `peerbit-fs status`
  and every `--json` result.
- **Creation** stays v9 by default until promotion. v10 requires
  `openSharedFs({ generation: "v10" })` or `peerbit-fs create --generation v10`.

### 2.4 Hard rule: no silent reinterpretation

- Neither generation's code deserializes the other's program or writes
  documents into the other's log.
- Opening a v9 address never migrates it. Migration is an explicit command
  that produces a new address, and it never mutates the v9 source except for
  the advisory freeze marker (section 8.4) and revocations the owner chooses.
- S1 tests: v10 payloads rejected by v9 ingest and the reverse; a signed v9
  naming entry replayed into v10 rejected; v9 program bytes and addresses
  unchanged (byte-for-byte fixture); unknown program variants fail with the
  typed error.

### 2.5 Implementation strategy

v10 must not fork the 14.7k-line `index.ts`. S0 extracts an internal
content-layer seam from `SharedFileSystem` with no behavior or wire change:
content publication (`touchChunks`, version construction in `writeFileInner`
and `writeBatchInner`), content reads (`fetchChunk`, `readFileVersion`), the
GC heal and sweep content steps, the disposal content closure
(`captureDisposalClosure`), and the Guard D content branch
(`guardAgainstLiveRemovals`). Naming, trust, lifecycle, readiness, bootstrap,
caches, and conflicts move to an abstract, variant-less base class; the
concrete v9 and v10 classes declare their own Borsh fields. `watch.ts`,
`ignore/policy.ts` (`instanceof FileVersion`), `changeset.ts`, and
`mount-backend.ts` must also learn the v10 classes.

## 3. Write path

### 3.1 Commit protocol

This extends the order in MERKLE_STORAGE_V1.md ("Patch publication"). One
internal commit serves `writeFile`, `writeBatch`, `patchFile`, and mounts:

1. Copy, validate, sort, and coalesce ranges before the first `await`.
2. Take local version leases on the content base and every observed head
   (section 5.1).
3. Check the path and expected node (the existing
   `SharedFsExpectedNodeMismatchError` checkpoints `initial` and
   `base-version`).
4. Build with `MerklePatchBuilderV1` (#329/#339) over a `Documents`-backed
   source and sink. It fetches only affected root-to-leaf paths and partial
   leaves, then puts new data blocks and new trees bottom-up.
5. Recheck the expected node (`before-version`).
6. Put the `MerkleFileVersionV1` last, as `unique`.
7. R4 (section 3.5): recheck that every newly introduced block is present and
   re-put any missing one from memory.
8. For a new file, append the naming event (`before-naming`); for an existing
   file, run the `after-version` check.
9. Advance the caller's base and release leases no longer needed.

A crash before step 6 leaves only unreachable blocks, and a visible version
never precedes its new blocks. Every ingest recomputes `contentRoot` through
`assertMerkleFileVersionV1`.

### 3.2 In-place operations

A new library API exposes the builder, and the mount uses it (section 4.3):
`patchFile(path, { patches, size, expectedNodeId, baseVersionIds, noOpIfHeadVersionIds, signal })`.

- **Overwrite:** partial leaves load and verify at most their base leaf;
  full-leaf overwrites skip the read.
- **Append:** a patch at or beyond the base size; the builder extends the old
  short final leaf when needed.
- **Truncate:** a smaller `size` drops whole subtrees without fetching them and
  rewrites only the boundary path.
- **Sparse growth:** a larger `size` without patches writes no data; the tail
  is authenticated zeros.
- **Truncate, then grow, in one commit:** a single build would keep base bytes
  between the truncation point and the old size. The commit runs two chained
  builds instead (truncate to the lowest size, then patch from that root) and
  publishes only the final root. The intermediate O(d) boundary blocks become
  orphans for GC.
- **Dirty sets beyond the builder's absolute limits** (256 MiB of patch bytes,
  65,536 changed leaves per build) chain builds the same way, so callers see
  no new limit.

S3 adds a builder option `repairUnchanged: "always" | "if-missing"`. Today the
builder re-puts a fully overwritten leaf whose hash is unchanged, to repair a
missing payload. Mount commits use `"if-missing"`: a presence probe replaces
the put, so rewriting identical bytes creates no documents.

### 3.3 Full-content `writeFile` and the no-op rule

`writeFile(path, bytes)` keeps its signature. v10 streams the bytes through a
new right-frontier `MerkleStreamBuilderV1` (each node hashed and written once;
migration reuses it) and compares each leaf and subtree hash with the leased
base tree at the same position. Matching positions are reused by reference
(R1) and only differing blocks are put: hashing stays O(F), puts are O(changed
blocks).

The no-op rule replaces `contentHash` equality (`writeFileInner` ~L5064): a
write is a no-op when the resulting root descriptor (`size`, `leafSize`,
`rootLevel`, `rootHash`) equals the single current head's. The native-mount
exact-head no-op (`noOpIfHeadVersionIds`) keeps its shape checks and returns
`mountWriteOutcome: "unchanged"`.

### 3.4 `writeBatch`

The ordering contract (`writeBatchInner` ~L5630) is unchanged: blocks for
every entry, versions (`putMany`, unique), the R4 recheck, naming (directories,
creates, deletes last), and the changeset manifest last. Blocks are not
manifest members, so the barrier stays metadata-only ("`readFile` may still
fetch bytes remotely"). Per-entry atomicity and non-atomicity across entries
are unchanged. Batch-wide block dedup uses one bounded in-memory id set.

### 3.5 Dedup rules that replace W1 and W2

| Rule                        | Applies to                                                         | Behavior                                                                                                                           | Replaces                                                     |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| R1 reuse by reference       | Untouched subtrees reachable from the leased base root             | Never re-put, fetched, or copied                                                                                                   | Re-put of unchanged chunks when the base is past the horizon |
| R2 changed blocks           | Every block whose hash differs from the base at its position       | Put `unique` if absent; `putPreferLinked` if present (refreshes arrival age and links the live head, like v9's unwitnessed re-put) | W1 witness query for non-root blocks                         |
| R3 root witness             | Root blocks only: a small file's single data block, or a root tree | On a full replica, skip the put when a version row younger than the skip horizon references it (the W1 query, on `blockRefs`)      | W1                                                           |
| R4 post-publication recheck | Blocks introduced by this commit                                   | `hasDocument` after the version put; re-put missing blocks from memory                                                             | W2 (which rechecked every chunk)                             |

`dedup: "off"` disables R3, so every block the commit introduces is put.
Reused subtrees are still not re-put (that would be O(file)); section 5.5
carries their safety argument.

### 3.6 What a version references

A `MerkleFileVersionV1` (#336) carries `id` (`version:` plus 32 random bytes),
`nodeId`, `parentVersionIds`, the stored `causalDepth`, `size`, `leafSize`,
`rootLevel`, `rootHash?`, `contentRoot`, advisory `createdAt`, `authorKey` and
`machineLabel`, `conflictResolution`, `changesetId?`, and `legacyWholeSha256?`
(set only by migration). It references zero or one block, its root, and its
size is independent of `F`. That removes v9's ceiling of about 8,000 chunks
(about 4 GiB) per version.

`contentRoot` is the content identity. Public results report it as
`contentHash: "merkle1:" + base64url(contentRoot)`, a prefix that can never
equal a v9 SHA-256 string, plus `legacyWholeSha256` when present (D5).

### 3.7 Leaf size

The proposed default is 256 KiB (D1):

- **Write amplification:** a 4 KiB edit writes 256 KiB. v9 writes at least one
  512 KiB chunk and rehashes the whole file.
- **Documents per sequential MiB:** 4 data documents, compared with 2 in v9
  and 16 with 64 KiB leaves. The only measured 64 KiB layout (the local-only
  adaptive-range branch) regressed sequential reads, writes, and opens, and A2
  says per-document cost dominates.
- **Small files** up to 64 KiB are one block at every size. With 64 KiB
  leaves, files between 64 and 512 KiB would gain a tree and more documents.
- **Cold random reads:** a 4 KiB read fetches 256 KiB (64x), instead of 128x
  with 512 KiB leaves.

The S8 benchmark decides between 256 and 512 KiB against section 9.3. 64 KiB
remains an allowed layout, not the default.

### 3.8 Bounds

The merged codec and builder bounds apply unchanged: wire at most 2 MiB,
fanout 256, depth at most 6, at most 8,000 parents per version, and the
builder's default and absolute limits. `writeBatch` keeps its 10,000-entry
limit and 12,000-member manifest cap.

## 4. Read path

### 4.1 Block source

`MerkleDocumentsBlockSourceV10` implements `MerkleBlockSourceV1`: a local
`entries.index.get` by `data2:`/`tree2:` id, then a remote fetch with the retry
budget and backoff of today's `fetchChunk` (~L5840); absence returns
`undefined`. The read session copies and verifies every result; a missing,
corrupt, wrong-type, wrong-level, or wrong-length block fails with `EIO`. A
bounded process-wide LRU of verified blocks keyed by id can safely be shared
across sessions, because blocks are self-certifying.

### 4.2 Library reads

- **`readFile` and `readFileWithVersion`** (~L5935) keep row-based head
  selection (`headsForNode`) and read the chosen version through a
  `MerkleReadSessionV1` in pieces of at most 64 MiB. `"exact"` mode reads only
  the visible head and throws `SharedFsVersionUnavailableError` on `EIO`.
  `"available"` mode keeps the ancestor walk; a candidate is complete only when
  a full verified read succeeds, as in v9.
- **Tree verification replaces the whole-file SHA-256 check:** `contentRoot`
  is recomputed from the signed descriptor and every block is checked against
  its id.
- **New:** `readRange(path, offset, length, { versionId, mode })`, O(returned
  leaves + depth).
- **`readVersionForMount`** (~L6072) is replaced for v10 by
  `openVersionRangeForMount(path, versionId)`, a lease-backed range session
  with `read(offset, length)` and `close()`.

### 4.3 Mount integration

The v9 `OpenFileState` (`mount-backend.ts` ~L251) holds the whole file in
`buffer`, plus `borrowedCommitSnapshot` and `baseContentHash`. A v10 state
replaces those three fields with `base` (version id, root descriptor,
contentRoot), `session` (a `MerkleReadSessionV1` over `base`), `lease` (on
`base` and the opened heads), and `layers` (a mutable top layer plus at most
one frozen commit layer). `length`, `mutationGeneration`,
`persistedGeneration`, `committing`, and the namespace fields are unchanged.

- **Open** resolves the entry and confirms `sameFileSnapshot` as today, takes
  the lease, and creates the session. No data is read. Read-only opens are lazy
  too, which subsumes #321's goal (D2).
- **`write()`** stays synchronous. It computes the offset (`O_APPEND` uses
  `state.length`), copies the data into the top layer's sorted range map
  (newest wins, overlaps split), updates `length`, and bumps the generation.
  With no `await`, the documented append-allocation invariant (`backend.write`,
  ~L2481) holds, and no base leaf is read at write time.
- **`read()`** resolves bytes from the newest layer back: a range written in a
  layer returns its bytes; an offset at or above that layer's truncation floor
  returns zeros; otherwise the next older layer is consulted, and finally
  `session.read` serves the base (zeros beyond the base size).
- **`truncate`** (`resizeState`) sets `length`, clips the top layer's ranges,
  and lowers its truncation floor.
- **`flush`, `fsync`, and `release`** keep `localCommit(state, cutoff, trigger)`.
  At commit start, synchronously: freeze the top layer and open an empty one,
  flatten the frozen layer into ascending, non-overlapping patches plus the
  final size (two builds if it truncated below the base size), and commit
  through `patchFile`. On success the base advances, the session re-roots, the
  frozen layer is dropped, and `persistedGeneration` advances. On failure the
  frozen layer merges back beneath the top layer. Committing past the cutoff is
  allowed, as today (`commitNow` snapshots the current generation).
- **No-op:** a built descriptor equal to the base, with unchanged opened heads,
  returns `unchanged` without publishing, as today (~L1441).
- **Memory** is distinct dirty bytes plus bounded caches, never more than v9's
  `F`.

For v10 targets, `mountWriteSemantics()` returns `"merkle-exact-head-patch-v1"`
and `mountReadSemantics()` returns `"merkle-verified-exact-range-v1"`.
Namespace semantics (`"node-guarded-namespace-v1"`) are unchanged. The backend
uses the v10 state only when both v10 strings are advertised; v9 targets keep
today's code path.

### 4.4 Semantics preserved, and what changes

Preserved: exact-version mount reads without ancestor substitution, the CAS
through `expectedNodeId` and `expectedParentNodeId`, publishing a concurrent
head on a head mismatch (never a rebase), per-state commit serialization, and
the conflict virtual paths.

Changed: a v9 open fails with `EIO` if any chunk is unavailable. A v10 open
succeeds, and `EIO` surfaces on the first read or commit that needs the
unavailable block. A commit never publishes over a base whose required path
could not be verified (D11).

## 5. GC and physical reclamation

### 5.1 Retention and leases

Version and naming retirement (`planDag`, ~L13701) and its keep set (the
newest `keepVersions`, anything younger than `retentionMs` or `graceMs`, pins,
delete-observed and recoverable versions) are unchanged. v10 adds
reference-counted **version leases** to the keep set. Range sessions, mount
states, and in-flight commits hold them; they have no TTL and are released by
`close()` and lifecycle close. The 60 s `pinVersions` TTL (~L12035) remains for
short library reads. Leases are local; section 5.5 covers remote GC.

### 5.2 Heal and mark

v9's heal pass (~L13986) already probes every distinct chunk of every
surviving version. v10 generalizes it into a tracing mark:

1. For each surviving version whose node is not damaged, walk its root closure
   with bounded concurrency and a memo set of visited block ids.
2. Resolve tree blocks locally, or heal them by a verified remote fetch. Check
   the root with `assertMerkleRootBlockV1` and the rest with
   `assertMerkleChildLevelV1`, then enqueue their children.
3. Data blocks get only an index presence probe; reads and the explicit scrub
   verify bytes. A missing data block is healed by a verified fetch or marks
   its node damaged.
4. **An unhealable missing or corrupt tree sets `sweepBlocked`:** its
   descendants are unknown, so no block is deleted in that run. Version and
   naming retirement still proceed for undamaged nodes; blocks they orphan are
   recorded next run.

Cost: O(surviving versions + distinct reachable trees) document reads plus
O(distinct reachable data blocks) index probes. Memory is the visited set, the
same order as v9's `owners` map. After the existing settle, the mark is
extended with the closures of versions that arrived during the run.

### 5.3 Sweep

- **Candidates:** `merkle-tree` and `merkle-data` rows older than
  `chunkGraceMs` by arrival time (`__context`) and absent from the mark. They
  enter a new ledger map, `blockCandidates`, with `firstSeenMs`.
- **Deletion** requires the block to be unmarked in two runs and
  `firstSeenMs <= runStartedMs - blockOrphanSpanMs`, with `blockOrphanSpanMs`
  defaulting to `max(minOrphanSpanMs, 48 h)`. The 48 h mirrors the fixed
  propagation slack in v9's retention floor (`retentionFloor`, ~L13589);
  section 5.5 explains why reused subtrees need it.
- **Before each delete:** recheck the one-hop referrers through the
  `blockRefs` index and skip the block if a present referrer is marked; then
  run the H0-verified delete of `deleteChunkVerified` (~L13424), which resolves
  the bytes first and restores the block if the CUT hit an unexpected head.
- **Order:** trees by descending level, then data. `chunkSweep: "immediate"`
  stays a manual-only bypass.
- **Report fields:** `deletedTreeBlocks`, `deletedDataBlocks`,
  `reclaimedBlockBytes` (logical), `markedTreeBlocks`, `probedDataBlocks`, and
  `sweepBlocked` with a reason.

Because the mark is complete, unreachable blocks at every level become
candidates in the same run; there is no level-by-level cascade.

### 5.4 Guard D for blocks

`guardAgainstLiveRemovals` (~L12153) gets a block branch, coalesced in the
existing 300 ms window like versions:

1. Skip a removed block that is suppressed or whose id does not match its
   content.
2. Climb reverse edges: present rows whose `blockRefs` contain the id, plus
   removed values from the same burst.
3. If any path reaches a present version row (not only a head, mirroring v9's
   "referenced by any present file-version row"), re-put the removed blocks
   bottom-up with `putPreferLinked`.
4. Bound the climb: depth at most 7, at most 64 referrers per step, at most
   1,024 visited rows. An exceeded bound, a failed lookup, or an ambiguous
   answer re-puts every structurally valid removed block. The safe failure is
   retained garbage.

Arming, bootstrap disarming, and lifecycle generations are unchanged.

### 5.5 Safety argument for reused subtrees

In v9, W1 re-puts every chunk that lacks a young witness, so the write itself
carries the bytes to every replica. R1 deliberately does not re-send untouched
subtrees. The residual risk is a remote full replica that retires the base
version (not among its 10 newest, older than 30 days, with a grace-old
descendant) and sweeps the base's unique subtree before the new version
arrives. Three mechanisms close it: the 48 h minimum orphan span (the same
propagation slack v9 assumes), Guard D on every replica holding the new version
(it re-puts the subtree when the CUT arrives), and GC heal from peers that
still hold the blocks. The writer's own lease protects its replica. Under the
same slack assumption as v9 (**A6**), a reachable block is never permanently
lost; section 9.3 gates this with race tests.

### 5.6 Other interactions

Snapshot segments hold only naming and version heads, so segment ledgers,
`store-exclusive` raw-block reclamation, and Guard D arming are unchanged.
Physical reclamation is unchanged too: GC deletes `Documents` entries and does
not promise disk compaction. GC still requires a full replica, and unknown
kinds are never deleted.

## 6. Snapshots, bootstrap, readiness, and disposal

### 6.1 Snapshots and bootstrap

v10 segments (format 2) contain naming heads and full `MerkleFileVersionV1`
heads, including tombstones, never blocks. The manifest payload binds the v10
program id as `storeId`. The overlay serves version documents; blocks are
fetched lazily through the block source and verified. A missing, corrupt,
unknown, or wrong-level block fails with `EIO`; only an authenticated absent
child reads as zeros. Overlay retirement, the write gate, and Guard D arming
keep their fail-closed order, and a partial replica cannot open a lease-backed
writable session.

### 6.2 Readiness

The per-address write-readiness gate is unchanged. A new v10 filesystem,
including a migration destination, is ready for its creator. Both
`peerbit-fs create --generation v10` and the migration tool publish a signed
snapshot so joiners have readiness evidence; joiners use `awaitWriteReady` as
today.

### 6.3 `prepareForDisposal` closure

`captureDisposalClosure` (~L10778) collects naming heads, content heads, the
distinct chunks those heads reference, and trust entries. In v10 the content
part becomes a streaming, memoized walk from every content head's root: each
tree block is resolved and verified, and the exact resident log hash of every
reachable tree and data block is recorded (`disposalEntryRef`). A missing block
fails closed. `deliverDisposalBatch` then delivers bounded batches of data
blocks, trees bottom-up, versions, naming, and trust, and the result reports
data, tree, version, naming, and trust counts separately. Cost stays O(live
closure), the same order as v9. The guard-settled check, the moving-view
rejection, and per-entry receipt semantics are unchanged.

### 6.4 What a persisted receipt means for a Merkle version

Let the full closure `C(V)` be version `V` plus every block reachable from its
root, and the change closure `Delta(V)` be `V` plus the blocks it introduced
relative to its content base. Then `C(V) ⊆ Delta(V) ∪ C(base)`.

A Peerbit persisted receipt proves that one exact entry was persisted by the
acknowledging leaders at that instant. A receipt over `Delta(V)` covers only
the change. It does not prove that any single leader holds `C(V)`: earlier
steps may have been acknowledged by other leaders, and no receipt promises
continuing custody. Such a result must be labeled `coverage: "delta-only"`. A
`"full-version"` proof must re-deliver `C(V)`, which is O(file).

v9 offers no per-commit remote receipts: mount durability is local-first
(README, "Production scope and threat model"). So v10 regresses nothing without
U1, and the FUSE gain does not depend on it.

**U1 (upstream, relayed through the owner): a persisted-root session, or
retained-root lease.** A leader verifies and retains an authenticated root
closure, then accepts a successor root plus changed blocks and atomically
advances the lease. The receipt then means "this leader holds all of
`C(V_k)`" at O(delta) per step. Only a future opt-in remote-durable commit mode
needs it; no slice here is blocked on it. Related asks from the 2026-09-27
upstream list: `putMany` all-or-none (#17), which would let block puts batch
safely, and put-phase diagnostics (#18), which matter more once each commit
puts 3-4 documents.

## 7. Conflicts, naming, trust, and ACLs

**Unchanged:** the per-node causal DAG and its stored-depth-then-id head order;
two patches on one base yield two heads even when their ranges are disjoint;
no automatic merge; `resolveConflict` publishes a version over all heads; the
naming CRDT, every `resolveNamingConflict` action, and `merge-directory`; the
rooted, transitive trusted-writer graph and non-retroactive revocation; no
reader ACL and advisory `authorKey`; changeset barrier semantics.

**Changed:**

- Conflict-resolution versions are constant-size and point at the selected
  root (v9 copied `chunkIds`, ~L6318).
- The `restore` action publishes an O(1) version instead of re-putting every
  chunk (`touchChunks(chunkDocs, "off")`, ~L8044). The retained head, Guard D,
  and heal protect its content, as in section 5.5.
- `contentHash` changes meaning (section 3.6, D5).
- The content-equality leak moves to leaf and subtree granularity, and omitted
  zero leaves reveal which leaf-aligned ranges are all zeros.
- A frozen v9 filesystem refuses writes in v10-aware releases (section 8.4).

## 8. Migration from v9

### 8.1 Principles

One-way freeze-and-copy to a new address. The v9 filesystem is retained
read-only. No dual write and no mixed log. Every step can be re-run, and a
fresh peer verifies the result before the address is distributed.

### 8.2 Tool and CLI shape

The library exports `migrateSharedFsV9ToV10(options)` and
`verifySharedFsMigration(options)`. The CLI is experimental until S8:

```text
peerbit-fs migrate plan   <v9-address> [--leaf-size 256KiB] [--history heads|retained] [--json]
peerbit-fs migrate run    <v9-address> [--leaf-size ...] [--history ...] [--trust carry|none]
                          [--state <file>] [--min-acks <n>] [--quiet-ms <ms>] [--json]
peerbit-fs migrate verify <v9-address> <v10-address> [--fresh-dir <dir>] [--json]
peerbit-fs migrate freeze <v9-address> --successor <v10-address>
peerbit-fs migrate thaw   <v9-address>
peerbit-fs migrate late-writes <v9-address> [--json]
```

`plan` changes nothing. It reports counts, live bytes, and the projected time,
disk, and network cost.

### 8.3 Procedure

1. **M0, preflight.** Open the source as a v9 full replica. Require
   `awaitWriteReady` with no bootstrap overlay, a settled resurrection guard
   (the `throwIfDisposalGuardUnsettled` condition), and a trusted migrating
   identity on access-controlled filesystems. As with `prepare-disposal`, any
   mount process using the same Peerbit directory must already be stopped; the
   tool cannot detect every such process.
2. **M1, freeze and capture** (section 8.4).
3. **M2, create the destination:** a v10 program with a fresh id, the chosen
   `defaultLeafSize`, and a root key (section 8.5).
4. **M3, convert content.** For each distinct content head, stream its chunks
   in order, verify each chunk hash plus a streaming whole-file SHA-256
   against `contentHash`, and feed `MerkleStreamBuilderV1`. Memory holds one
   chunk, one leaf, and the tree frontier. Heads with equal content share one
   root, and `legacyWholeSha256` records the verified v9 hash.
5. **M4, copy metadata.** Each current content head becomes a
   `MerkleFileVersionV1`, and each naming head (tombstones and conflicts
   included) a `shared_fs_v10_naming_event`. Both keep their ids, parent ids,
   stored causal depths, `createdAt`, attribution, and `changesetId`. Absent
   historical parents are valid under the current DAG rules, so heads,
   winners, and conflict sets are preserved (**A7**, tested in S7).
   `--history retained` also converts every retained non-head version, at
   O(retained bytes). Changeset and bootstrap manifests are not copied: they
   are inner-signed and bound to the v9 `storeId`.
6. **M5, publish** blocks, then versions, then naming, then a signed v10
   snapshot. The `--state` file records the capture digest, destination
   address, and per-version progress. Content addressing and preserved ids
   make a re-run idempotent (existing ids are skipped after a presence probe).
7. **M6, recheck the source.** Recompute the capture digest. On any change,
   abort and list the moved entries. The destination is not yet distributed
   and can be discarded.
8. **M7, verify** (section 8.6).
9. **M8, fence (optional):** with `--min-acks`, run `prepareForDisposal` on the
   destination.
10. **M9, cut over:** publish the successor marker in v9 (section 8.4), print
    the new address, and keep v9.

### 8.4 Freeze fence and in-flight writers

Without an upstream log frontier, the freeze is operational plus detection:

1. **Quiesce.** The operator stops every mount and writer on every machine,
   the same precondition as `prepareForDisposal`.
2. **Capture.** The tool waits for a quiet window (`--quiet-ms`, default 60 s)
   without filesystem or trust arrivals, then records the capture digest:
   SHA-256 over the sorted `(id, exact log head)` of every naming and version
   row plus the trust-log entry hashes. Chunks need no entry, because a head's
   chunks cannot change unless its row does.
3. **Advisory marker.** A member-less v9 `ChangesetManifest` with
   `changesetId = "shared-fs-freeze:" + <v10 address>`, inner-signed by the
   migrating identity. v9-only peers admit and ignore it. v10-aware releases
   treat a marker from a trusted signer (any signer on a filesystem without
   access control) as frozen: they refuse v9 writes with `EROFS` (a new
   `SharedFsErrorCode`) and name the successor. Because v9-only GC may retire
   manifests after the retention window, v10-aware releases persist a local
   sidecar once they see a marker and exempt freeze manifests from their own
   manifest sweep. `thaw` publishes a newer `shared-fs-thaw:` manifest.
4. **Late-write detection.** `migrate late-writes` lists v9 entries that
   arrived after the capture digest, so a write from a v9-only or partitioned
   peer is detected, never silently lost. The operator re-applies it to v10,
   for example with `writeBatch` from the read-only v9 bytes.
5. **Revocation (optional, access-controlled only).** The owner may revoke v9
   writer edges after cutover; revocation is eventually convergent and not
   retroactive (D8).

### 8.5 Trust carryover

The v10 root key defaults to the v9 root key, so the owner runs `run` with the
root identity; `--root-key` selects a new root. `--trust carry` reads the v9
`trustedWriters()` from the converged graph and has the root authorize each key
directly, at O(writers). Revoked keys are not carried. **Delegation topology is
flattened** (D7): root to A to B becomes root to A and root to B, and only the
root can revoke afterwards. A v9 filesystem without a root key becomes a v10
filesystem without one. Trust entries are never replayed, and the new variants
and trust domain make that impossible anyway (section 2.2).

### 8.6 Verification

`migrate verify` opens both addresses from a fresh Peerbit directory (full
replica, fresh identity, remote fetch enabled), waits for v10 write readiness,
and compares:

- every visible path, node id, and kind; naming heads with `parentId`, `name`,
  and `deleted`; and `namingConflicts()`;
- per file: head version ids, the visible head, `size`, `conflicts()`, and
  `legacyWholeSha256` against the v9 `contentHash`;
- every head's bytes, streamed through `readRange` into SHA-256 and compared
  with the v9 hash (O(total bytes)), and `contentRoot` recomputed from the
  signed descriptor;
- the carried trusted writers against v10 `trustedWriters()`, and counts of
  nodes, heads, tombstones, and conflicts.

It emits a JSON report. Any mismatch exits nonzero and blocks cutover.

### 8.7 After migration, and rollback

- **v9 is retained read-only.** v10-aware peers open it with
  `handle.frozen = { successor }`, and it stays readable for audit, rollback,
  and `prepareForDisposal`. Its space is reclaimed only when operators delete
  its Peerbit state after accepting the cutover.
- **Rollback before cutover:** discard the v10 address, and `thaw` if a marker
  was published. Nothing references v10.
- **Rollback after v10 writes:** the first release has no reverse converter.
  Thaw v9 and re-apply v10-only changes with a `late-writes`-style export. They
  land as new v9 versions, and v10's intermediate causal history is lost; the
  v10 filesystem stays readable. This is explicit divergence, never a merge.

### 8.8 Mixed-version fleets

| Peer release                      | Opens a v9 address                              | Opens a v10 address                                                            |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Current v9 releases (0.13.x)      | read-write                                      | fails at program decode with a raw Borsh error (cannot be fixed retroactively) |
| v9-line bridge release (proposed) | read-write                                      | explicit `SharedFsUnsupportedGenerationError` naming the minimum version       |
| v10-aware (proposed next minor)   | read-write in the window; read-only when frozen | read-write                                                                     |

The bridge is a small v9-line patch: the generation probe, the typed error,
and optionally honoring the freeze marker. v10-aware releases keep v9
read-write for a compatibility window (D9), then read-only as a migration
source.

### 8.9 Mounts during migration

Mounts must be stopped for capture and copy. A remote mount that keeps writing
is caught by the capture-digest recheck (M6) or, after cutover, by
`late-writes`. After cutover, operators remount with the new address. A
v10-aware mount of a frozen v9 address is read-only and warns; v9-only mounts
keep writing to v9.

### 8.10 Time and space

Notation: `L` is the distinct live head bytes, and `N` and `V` the naming and
content head counts. `--history retained` adds the retained non-head bytes.

| Phase            | Work                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Read and verify  | read `L`; hash about `2L` (chunk ids, streaming whole-file SHA-256)                                                              |
| Build and put    | hash about `2L` (leaf ids, post-sink check); put about `L/B` data and `L/(256B)` tree documents, `V` versions, `N` naming events |
| Verify           | fetch `L` to the fresh peer; hash about `2L`                                                                                     |
| Destination disk | at most `L` plus ~`32L/B` tree bytes (0.012% at 256 KiB) plus index rows; zero leaves are omitted                                |
| Peak disk        | the v9 store plus the destination, until v9 state is deleted                                                                     |
| Each replica     | downloads about `L` again, because v10 blocks differ from v9 chunks                                                              |

**A8:** migration is bound by `Documents` put throughput. The only related
measurement is the unprofiled 1 MiB FUSE write p50 of 30.9 ms (about 32 MiB/s
including FUSE). At an assumed 30 MiB/s, 10 GiB takes about 6 minutes to copy
plus a similar verification pass; S7 measures the real rate. Pre-seeding
replicas by local conversion (blocks are deterministic from content) is out of
scope, because the entries would be signed by different keys.

## 9. Rollout

### 9.1 Slices

Each slice is one reviewable PR with its own tests and changeset, and v9 stays
green on the strict three-OS gate after every slice.

| Slice | Content                                                                                                                                                                                                                | Tests and gate                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S0    | Content-layer seam in v9 (section 2.5), no wire or behavior change                                                                                                                                                     | v9 program-bytes and address fixture; entry wire fixtures; full strict suite; benchmark within 1.05x                                   |
| S1    | Generation identity: v10 program, salt, entry root and variants, v10 index, strict v10 ingest (`canPerformEntry`), generation probe, `handle.generation`, typed errors. Rebased #329 builder and #339 hashing fix (D6) | Cross-generation rejection both ways; v9 entry replay rejected; golden vectors unchanged after re-parenting (A4); probe errors (A5)    |
| S2    | Library content: `Documents` block source and sink, `MerkleStreamBuilderV1`, `writeFile`, `writeBatch`, `readFile`, `readFileWithVersion`, `readRange`, R1-R4, no-op; opt-in `generation: "v10"` create                | Crash injection at every publication boundary; randomized byte-oracle tests; exact and available reads; conflict convergence           |
| S3    | `patchFile`, version leases, `repairUnchanged`, chained builds for truncate-then-grow and large dirty sets, work counters                                                                                              | Zero whole-file hash bytes; flat 4 KiB patch cost from 4 MiB to 1 GiB (library); lease and GC interplay                                |
| S4    | Mount: v10 open state, layered overlay, generation-bounded `flush`/`fsync`/`release`, truncate and append, v10 semantics strings                                                                                       | Existing `mount-backend` suites parameterized over both generations; native smoke; Linux FUSE profile against section 9.3              |
| S5    | GC heal and mark, block ledger and sweep, reverse-edge Guard D, lease keep set                                                                                                                                         | Randomized GC, read, write, and CUT races; orphans reclaimed after the barrier; a missing retained tree blocks the sweep               |
| S6    | v10 snapshots (format 2), overlay block fetch, readiness evidence, disposal closure walk                                                                                                                               | Cold-start, bootstrap, and `durable-disposal` suites on v10; process-crash suite                                                       |
| S7    | Migration library and CLI, freeze and thaw marker, trust carryover, verifier, `late-writes`; separate v9-line bridge PR                                                                                                | Ids, winners, conflicts, tombstones, sparse and large files; resume after kill; source-moved abort; bounded-memory conversion of 1 GiB |
| S8    | Promotion: both generations in the three-OS matrix, the FUSE comparison, the leaf-size decision, docs                                                                                                                  | Section 9.3; the create default flips only on owner approval (D3)                                                                      |

### 9.2 Opt-in

Until S8 is approved, v10 is created only with `generation: "v10"` (library)
or `--generation v10` (CLI), and `peerbit-fs migrate` requires
`--experimental`. Opening an existing address needs no flag, because the
address determines the generation. `SHARED_FS_EXPERIMENTAL` stays `true`.

### 9.3 Acceptance criteria for promotion

**Strict CI:** Ubuntu, macOS, and Windows, both generations, no retries, no
timeout inflation.

**Structural counters** (the MERKLE_STORAGE_V1 gates): patch commits report
zero whole-file hash bytes; base data fetched is at most one leaf per changed
leaf plus one truncate boundary leaf; new data blocks are at most the changed
non-zero leaves; new tree blocks are at most the unique dirty ancestors;
encoded version size is flat from 16 MiB to 1 GiB; peak memory is bounded by
dirty bytes plus configured caches.

**Linux FUSE**, same runner class, A-B-B-A as in the #358 runs (**A9:** runner
variance allows these ratios; confirm with unprofiled baselines):

| Metric (p50 unless noted)                | v9 today             | v10 gate                          |
| ---------------------------------------- | -------------------- | --------------------------------- |
| 4 KiB overwrite in 32 MiB                | 431-481 ms           | <= 60 ms and >= 8x faster than v9 |
| 4 KiB overwrite, 32 MiB / 4 MiB          | 10.7x                | <= 1.5x                           |
| 4 KiB overwrite, 512 MiB / 4 MiB         | not measured         | <= 2x                             |
| `mount.localCommit`, 32 MiB / 4 MiB      | 11.1x                | <= 1.5x                           |
| Writable open, 512 MiB / 4 MiB           | ~6x from 4 to 32 MiB | <= 1.5x                           |
| `fsync` fence p95 at 32 MiB              | 307 ms               | <= 100 ms                         |
| stat, readdir, read 4 KiB                | baseline             | <= 1.10x of v9                    |
| write 4 KiB (small file), 16 small files | baseline             | <= 1.15x and <= 1.10x of v9       |
| read 1 MiB, write 1 MiB                  | baseline             | <= 1.25x of v9                    |

**Correctness:**

- **Crash and reopen:** a kill after data puts, tree puts, the version put, or
  naming reopens to the old or the new version, never a partial one, and never
  `EIO` on reachable content.
- **Disposal:** persisted `minAcks` on all three OSes; recipients reopen alone
  with remote fetch disabled and verify every head's full closure.
- **Conflicts:** disjoint concurrent patches on one base give identical head
  sets on both peers; resolution versions are constant-size.
- **Corruption:** every leaf, tree, root, level, length, and missing-block case
  fails with `EIO`; available mode falls back exactly where v9 does.
- **GC:** no race removes a block reachable from a retained or leased version,
  and true orphans disappear after the barrier.
- **Migration:** byte-exact, with ids, winners, conflicts, and tombstones
  preserved, verified from a fresh peer.

The comparator is v9 master on the same runner. MERKLE_STORAGE_V1's comparison
with the local-only phase-1 flat-patch branch (`fa13d1e1`) is dropped, because
that branch requires #321 and is not on origin (D2).

### 9.4 What to measure

- #358 profiler phases plus new ones: `mount.target.patchFile`,
  `merkle.build`, `merkle.blockPut`, `merkle.versionPut`, `mount.lazyRead`.
- Builder and reader counters for every commit and read session.
- GC reports: mark size, probes, blocked sweeps, reclaimed blocks and bytes.
- Migration throughput, peak RSS, peak disk, and verify time.
- The 4, 32, and 512 MiB overwrite scenarios for v9 and v10 in one campaign.

## 10. Risks, open decisions, and assumptions

### 10.1 Risks

- **Integrity bugs** in the builder or reader could corrupt data. Mitigated by
  golden vectors checked in TypeScript and Go, byte-oracle tests, `contentRoot`
  recomputed on every ingest, and fail-closed `EIO`.
- **Reused subtrees weaken v9's re-put protection** (section 5.5). The 48 h
  span, Guard D, and heal mitigate it; the S5 race tests gate it.
- **More documents per sequential MiB** (4 against 2) may regress 1 MiB
  writes. Gated in section 9.3; it drives D1.
- **Index growth:** tree rows carry up to 256 `blockRefs`, well under the
  indexer's roughly 8,191-row batch ceiling; data rows grow with `L/B`.
- **API meaning change** of `contentHash` for watch events, CLI output, and
  applications (D5).
- **Migration cost:** twice the disk at peak, and a full re-download on every
  replica.
- **Lazy opens** move `EIO` from open time to read time (D11).
- **Only Linux FUSE has been measured.** macOS and Windows mounts may differ;
  macOS evidence is blocked on macFUSE capacity.
- **Workload fit:** v10 helps in-place writers (databases, disk images, logs,
  editors that save in place). Atomic-save editors and small-file workloads
  gain nothing. This is a product question.
- **The S0/S1 refactor** touches `index.ts` broadly; the v9 address-bytes and
  wire fixtures are the guard.

### 10.2 Open decisions for the owner

- **D1. Default leaf size:** 256 KiB proposed, 512 KiB the alternative, 64 KiB
  not proposed as default. Final choice in S8.
- **D2. #321's zero-byte layout marker:** recommend dropping it for good and
  closing #321, since v10 gives lazy verified range reads natively without a
  v9 layout convention or mixed-version admission divergence. Reconsider only
  if v10 is delayed and read-only large-file opens matter meanwhile. Also
  confirm v9 master as the performance comparator.
- **D3.** When the create default flips to v10, and whether v9 creation is
  removed then.
- **D4. Program variant name:** `peerbit_shared_fs_v10_merkle_v1` proposed
  (MERKLE_STORAGE_V1 had the provisional `peerbit_shared_fs_merkle_v1`).
  Either works if never reused.
- **D5. Public `contentHash` in v10:** the `merkle1:`-prefixed content root
  plus `legacyWholeSha256` for migrated versions (proposed), or a new
  `contentRoot` field with `contentHash` left undefined.
- **D6.** Merge #329 and #339 in S1 or S3 as experimental exported API (about
  104 KB unpacked), or keep them unexported until integrated.
- **D7. Migration UX:** explicit CLI only (proposed) or also a prompt on open;
  heads-only history by default (proposed) or all retained history; trust
  flattened to root edges (proposed), preserved topology (needs every
  delegator's key), or no carryover.
- **D8. Freeze enforcement:** the advisory marker plus detection (proposed);
  that plus mandatory revocation of v9 writers on access-controlled
  filesystems; or an out-of-band announcement only.
- **D9. Compatibility window:** how long v10-aware releases keep v9 read-write
  (proposal: at least two minor releases and at least 3 months after
  promotion), and whether the v9-line bridge release ships.
- **D10.** Leaf size fixed per filesystem in the program (proposed) or
  selectable per writer.
- **D11. Mount open semantics:** lazy verification (proposed), with an optional
  `verifyOnOpen: "full"` for callers that want v9's open-time failure.
- **D12. Reclamation latency:** the 48 h minimum orphan span delays space
  recovery for blocks. Accept it, or shorten it with evidence.

### 10.3 Assumptions register

| Id  | Assumption                                                                                                 | Checked in                 |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| A1  | Ingest re-validation of local puts adds about `B` hashing per new data block                               | S2 (counters)              |
| A2  | Per-document put cost dominates small commits and is roughly linear in document count                      | S3/S4 profiles             |
| A3  | SHA-256 throughput is at least 300 MiB/s in the runtime                                                    | S3 micro-benchmark         |
| A4  | Re-parenting `MerkleContentEntryV1` under `SharedFsEntryV10` keeps every golden vector and dispatch intact | S1                         |
| A5  | The stored program's variant can be read before a full open                                                | S1                         |
| A6  | Propagation slack is at most 48 h, as v9 already assumes                                                   | S5 race tests; documented  |
| A7  | Absent historical parents preserve heads, winners, and conflicts after a head-only copy                    | S7                         |
| A8  | Migration is bound by `Documents` put throughput (about 30 MiB/s assumed)                                  | S7                         |
| A9  | Runner variance allows the section 9.3 ratios                                                              | S4/S8 unprofiled baselines |

## 11. Changes relative to MERKLE_STORAGE_V1.md

- Program variant `peerbit_shared_fs_v10_merkle_v1` (D4), and a v10 variant
  for every entry kind, not only the program, because log entries are not bound
  to a log address (section 2.2).
- A `SharedFsEntryV10` root and a combined v10 index row (section 2.1).
- Dedup rules R1-R4, the `repairUnchanged` builder option, and chained builds
  (sections 3.2 and 3.5).
- The mount overlay as synchronous, layered byte ranges with a truncation floor
  (section 4.3).
- GC blocks the sweep only for an unhealable missing or corrupt tree (a missing
  data block damages only its node), blocks get a 48 h minimum orphan span, and
  Guard D re-puts when any present version is reachable (section 5).
- Performance comparator: v9 master, not the phase-1 flat-patch branch
  (section 9.3).
- Migration details for history, trust, freeze, late writes, and verification
  (section 8), and 256 KiB as the proposed default leaf size (D1).
