# Shared FS v10: the Merkle storage generation and v9 migration

Status: design for owner review, revision 3. Owner decision of 2026-09-27:
"design v10 first". Nothing in this document is implemented, and no v10
format, program, or migration code should land before it is approved.
Revisions 2 and 3 answer two rounds of adversarial review; section 12 lists
what changed, by finding number.

[MERKLE_STORAGE_V1.md](MERKLE_STORAGE_V1.md) remains the normative content
format: hash domains, codecs, root descriptor, and golden vectors. This
document specifies how that format becomes a live filesystem generation
("v10") and how existing v9 filesystems move to it. Section 11 lists where it
refines, weakens, or replaces parts of the earlier proposal.

Conventions:

- **A#** is an unverified assumption, with the slice that must check it
  (section 10.3). **D#** is an open decision for the owner (section 10.2).
- **U#** is an upstream (dao-xyz/peerbit) need. Upstream work is out of scope
  for this repository and is relayed through the owner (section 10.4).
- Code references are to master `4a450e70` unless a PR head is named. Line
  numbers are approximate.

## Key decisions

1. **A new generation with a new address.** Program variant
   `peerbit_shared_fs_v10_merkle_v1`, entries salt `/shared-fs/v10-merkle-v1`,
   a fresh program id, and a distinct Borsh variant for every entry kind.
   Every signed metadata document (naming events and file versions) is bound
   to its own store id, so entries cannot be replayed between generations or
   between two v10 filesystems.
2. **A store-bound trust program.** The upstream trust relation binds no
   network, so v9 grants (including revoked ones) could otherwise be replayed
   into v10. v10 uses an in-repo trust program whose relations carry the
   filesystem's store id and are rejected anywhere else (section 2.3). It
   replaces revision 2's time-based rule, which relied on author-asserted
   clocks. Upstream network-bound relations (U2) can replace it later (D22).
3. **Content** uses the merged Merkle v1 codecs unchanged (sparse radix tree,
   fanout 256). The proposed default leaf size is 512 KiB, the v9 chunk size
   (D1), because Linux `Documents.put` costs about 3 ms per document.
4. **Path-copy writes with v9's witness rule.** A 4 KiB in-place overwrite puts
   one data block, at most `rootLevel` tree blocks, and one constant-size
   version. A block the new version shares with existing content is not re-put
   when a version younger than the skip horizon already reaches it; otherwise
   it is re-put, as v9's W1 re-puts unwitnessed chunks. No-op writes and
   writable opens put nothing. Reuse is full-replica-only.
5. **Lazy verified reads; full rewrites need no old content.** Read-only opens
   read nothing. Writable opens without `O_TRUNC` verify the root and the
   rightmost path, and prefetch base leaves in the background. Full-coverage
   writes never read base data. A commit that fails permanently spills its
   dirty ranges to a recovery file instead of stranding them.
6. **GC** marks the closure of every present version and every leased root
   (damaged nodes included), vetoes a delete while any live referrer remains,
   and keeps a clamped 48 h orphan span as defense in depth. While a present
   version references an unhealable tree, the block sweep stays blocked; the
   exit is resolving the file, optionally followed by an explicit early
   retirement of the superseded broken version.
7. **Durability semantics are unchanged for full replicas.** Mount commits stay
   local-first and disposal stays O(live closure). Partial-replica writers
   re-put every block they reference, as in v9. O(delta) remote full-version
   durability needs U1 and is not claimed.
8. **Migration is an explicit, one-way freeze-and-copy** to a new address. It
   persists the captured semantic state and row ids, verifies from a fresh
   peer with an independent trust computation, and fails closed on heads it
   cannot convert. Freeze, thaw, and successor markers count only when the v9
   root key signs them, are protected as one set, and successor-less freezes
   expire. Trust changes after capture are listed, never mirrored
   automatically. The v9 filesystem is retained read-only.
9. **Rollout** is nine slices behind an opt-in `generation: "v10"`, promoted
   only after the strict three-OS CI and Linux FUSE gates computed within one
   job, with v9 and v10 interleaved.

## 1. Goals, non-goals, and the measured problem

### 1.1 Measured problem

Source: `shared-fs-evidence/mount-profile-runs-20260927/FINDINGS.md` (Linux
FUSE, GitHub `ubuntu-latest`, master `cfa9c2fb` = 0.13.16 plus the #358
profiler, Peerbit 5.4.6). Unprofiled p50s are from the benchmark jobs of runs
36342670967 (4 MiB base) and 36342681298 (32 MiB base). Profiled figures are
from pass B1 of runs 36342675857 and 36342681298. Ratios between the two base
sizes compare separate jobs, so they carry cross-job noise (section 9.3).

| 4 KiB overwrite                 | 4 MiB base | 32 MiB base | growth |
| ------------------------------- | ---------: | ----------: | -----: |
| Unprofiled p50                  |    44.9 ms |      481 ms |  10.7x |
| Profiled, per sample            |    50.9 ms |      431 ms |   8.5x |
| Of which local commit           |    31.7 ms |      353 ms |  11.1x |
| Service minus commit (open)     |     ~11 ms |      ~70 ms |    ~6x |
| Local-disk control (unprofiled) |    0.38 ms |           - |      - |
| Per-sample `fsync` p95          | 132-298 ms |  391-535 ms |      - |

"Service minus commit" is the daemon `ipc.service` p50 minus the
`mount.localCommit` p50; FINDINGS attributes it mostly to the writable open,
which loads and verifies the whole file. The per-sample `fsync` p95 is the
scenario's own `fsyncNs` over 30 samples, across the passes of each run. The
figures FINDINGS quotes (p95 307 ms, max 857 ms) are pass-wide statistics over
all 632 commit fences in the 32 MiB profiled pass; the 857 ms maximum was the
write of the 32 MiB base file itself, outside any sample window.

**Fixed per-commit cost (FINDINGS addendum, run 36346400850).** About 94% of a
9.5 ms small `writeFile` is upstream `Documents.put`, at roughly 2.7-3.0 ms
per put on the Linux runner (about 0.6-0.7 ms on macOS arm64 locally). A
presence probe costs about 0.27 ms. The `writeFile` p95 is about 110 ms. Every
document a v10 commit puts therefore costs about 3 ms on Linux, and this
document's projections are derived from that figure.

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
  in O(changed leaves x tree depth), through the library and the mount, on
  full replicas, whenever the content they reuse is reached by a version
  younger than the skip horizon.
- **G2.** Read-only mount opens are O(1) and writable opens O(depth); a read
  is O(returned leaves + depth).
- **G3.** Every v9 safety property holds: fail-closed integrity (`EIO`, never
  invented zeros), per-node causal conflicts, the naming CRDT, the trust model
  including revocation, GC never deleting reachable content, the disposal
  fence, and the write-readiness gate. Two failure modes move (section 4.4): a
  partial write can fail at commit time when a base block it needs disappears
  after a writable open, where v9 failed the open instead; and a partial write
  over a stale base fails if the untouched content it must re-put is
  unavailable, where v9 re-puts it from its in-memory buffer. Full rewrites
  never need the old content.
- **G4.** A one-way, verifiable migration from any v9 filesystem whose heads
  are convertible, with explicit handling of those that are not.
- **G5.** Structural work counters prove the complexity change independently
  of timing.

### 1.4 Non-goals, and deliberate v9 behavior changes

Non-goals:

- No mixed-log rolling upgrade, no dual write, no automatic block-level merge.
- No O(delta) remote full-version durability without U1.
- No compression, encryption, reader confidentiality, or per-file ACL.
- Little gain for writers that replace files (temporary file plus `rename`,
  the usual "atomic save") or copy them. A new node hashes every byte. Blocks
  that already exist and are reached by a young version are not re-put (R3,
  section 3.5), so puts match v9, plus bounded reverse-edge queries.
- No gain for the first edit of a file whose reused content no young version
  reaches: those blocks are re-put, as v9 re-puts unwitnessed chunks
  (section 3.5).
- No change to the fixed per-document cost (about 3 ms per put on Linux, an
  upstream matter, #18) or to metadata transport (0.18 ms per callback).

v9 wire and behavior stay unchanged except for these deliberate exceptions:

- S0's behavior-preserving refactor (section 2.6).
- The optional v9-line bridge release (section 8.10).
- In v10-aware releases only, on a v9 address: honoring root-signed freeze
  markers (`EROFS` for new writes, suspended v9 GC), reserving the marker
  prefixes in `writeBatch`, and, after the compatibility window (D9), opening
  v9 read-only.

### 1.5 Cost model for a 4 KiB overwrite

Notation: file size `F`, leaf size `B`, `n = ceil(F / B)` leaves, root level
`d` (0 for one leaf, else the smallest `d` with `256^d >= n`). The write stays
within one leaf; crossing a leaf boundary doubles the data terms. Encoded sizes
derived from the codecs: a data block is about `B + 0.1 KiB`; a tree block is
about `0.1 KiB + 32 B x children` (at most ~8.1 KiB); a v10 version document
is about 0.6 KiB regardless of `F`; a v9 version grows by ~53 B per chunk id.
"Put time" uses the measured 2.7-3.0 ms per put (Linux). The base is younger
than the skip horizon unless stated.

**v10, 512 KiB leaves (proposed default):**

| File    | Leaves | `d` | Trees on path (children)    | Docs put | Put time     | Bytes put | Hashed (library) |
| ------- | -----: | --: | --------------------------- | -------: | ------------ | --------: | ---------------: |
| 4 MiB   |      8 |   1 | root (8): 0.4 KiB           |        3 | 8.1-9.0 ms   |  ~513 KiB |         ~1.5 MiB |
| 32 MiB  |     64 |   1 | root (64): 2.1 KiB          |        3 | 8.1-9.0 ms   |  ~515 KiB |         ~1.5 MiB |
| 512 MiB |  1,024 |   2 | root (4), L1 (256): 8.3 KiB |        4 | 10.8-12.0 ms |  ~521 KiB |         ~1.5 MiB |

"Docs put" counts the data block, the path tree blocks, and the version.
"Hashed" counts the base-leaf verification (`B`), the new leaf twice (`2B`,
per #339's `createWithHash`), and the path trees. Base data fetched is at most
one leaf; path trees are cached after the first commit. Index work is about
`2(d + 1)` presence probes (R2 and R4, section 3.5), about 1.1-1.6 ms, plus the
existing node, head, and namespace checks. **A1:** ingest re-validation of
local puts adds about `B` of hashing.

**Other leaf sizes, same edit (docs put per file size, hashing):**

| Leaf    | 4 MiB | 32 MiB | 512 MiB |    Hashed |
| ------- | ----: | -----: | ------: | --------: |
| 64 KiB  |     3 |      4 |       4 | ~0.19 MiB |
| 256 KiB |     3 |      3 |       4 | ~0.75 MiB |

**Stale base (no version younger than the 15-day skip horizon reaches the
reused content).** A no-op still puts nothing, and so does a writable open.
Otherwise the commit also re-puts every block it reuses without a young
witness (section 3.5): for a 4 KiB edit, the untouched leaves and the
untouched subtrees. At 512 KiB leaves that is about 7 extra puts for a 4 MiB
file, 63 for 32 MiB, and about 1,026 for 512 MiB, so about 30 ms, 200 ms, and
3.1 s of put time in total. v9 re-puts the same number of chunks in this case
(7, 63, and 1,023 unchanged chunks) from its in-memory buffer; v10 must first
read the untouched leaves from the local store. After that commit the new
version is the young witness. A full rewrite of a stale file puts only the new
version's blocks, as v9 does.

**v9, 512 KiB chunks, same edit:**

| File    | Chunks `n` | Hashed at open | Hashed at commit | Index ops (commit) | Chunks put                     | Version size |
| ------- | ---------: | -------------: | ---------------: | -----------------: | ------------------------------ | -----------: |
| 4 MiB   |          8 |          8 MiB |            8 MiB |           up to 24 | 1, or 8 if base >= 15 days old |     ~0.4 KiB |
| 32 MiB  |         64 |         64 MiB |           64 MiB |          up to 192 | 1, or 64                       |     ~3.4 KiB |
| 512 MiB |      1,024 |          1 GiB |            1 GiB |        up to 3,072 | 1, or 1,024                    |      ~54 KiB |

The v9 open also allocates and copies `F` bytes; the v10 open allocates
nothing proportional to `F`.

**A 1 MiB `O_TRUNC` rewrite** (the benchmark's `write-1048576`, new payload
each sample) puts 3 documents in v9 (2 chunks and a version). v10 puts 4 with
512 KiB leaves (2 data, a root tree, the version), 6 with 256 KiB leaves, and
18 with 64 KiB leaves. At about 3 ms per put against a v9 sample of 28-31 ms,
that projects about 1.1x for 512 KiB and about 1.3x for 256 KiB, which would
fail the 1.25x gate unless concurrent puts overlap (A2b). This is why D1 now
proposes 512 KiB.

### 1.6 Projected latency (a projection, not a measurement)

Using the measured put cost, and **A3** (SHA-256 at 300 MiB/s or more), a v10
4 KiB overwrite commit at 512 KiB leaves costs about 8-12 ms of puts, at most
5 ms of hashing (likely 1-2 ms), 1-2 ms of probes, and about 1 ms to read and
verify one local base leaf: roughly 12-20 ms, at every size in the table. The
writable open verifies O(depth) tree blocks (1-2 ms). Adding the ~8 ms per
sample that v9 spends outside the daemon service (transport, callbacks,
kernel) projects about 22-32 ms per mounted sample, against 45-51 ms (4 MiB)
and 431-481 ms (32 MiB) today. The claim is flatness in `F` for young bases,
not these absolute numbers; section 9.3 sets gates with margin.

### 1.7 What still costs O(file) or more than O(delta)

- Full reads (`readFile`, `readFileWithVersion`, reading a whole file through
  the mount) and the `available`-mode ancestor fallback, as in v9. The first
  read of each leaf fetches and verifies the whole leaf.
- Full-content `writeFile(path, bytes)` and an in-place `O_TRUNC` rewrite
  through the mount: every rewritten byte is hashed, but no base data is read,
  and only blocks that are new or lack a young witness are put (sections 3.3
  and 3.5). Scattered small writes cost one full leaf write (`B`) and hash per
  touched leaf.
- File replacement by rename and copies hash every byte and run one bounded
  reverse-edge climb per block that already exists (R3); an explicit
  leaf-size change puts every block.
- The first commit, other than a no-op, whose reused content no young version
  reaches: those blocks are re-put, untouched ones after a local read
  (section 3.5). v9 re-puts the same chunks from memory.
- Full-content writes on a partial replica: every block is put (v9 parity).
- GC heal and mark: O(distinct reachable blocks) per GC run, the same order as
  v9's heal pass (`index.ts` ~L13986). No write pays it.
- Disposal and any full-version remote durability proof, until U1.
- Migration and its verifier (one time).

## 2. Generation identity

### 2.1 Identifiers

| Item                   | v9 (today)                              | v10 (proposed)                                                                                            |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Program variant        | `peerbit_shared_fs` (`index.ts` ~L2073) | `peerbit_shared_fs_v10_merkle_v1`                                                                         |
| Entries salt           | `/shared-fs/v9` (~L2387)                | `/shared-fs/v10-merkle-v1`                                                                                |
| Program id             | random 32 bytes                         | fresh random 32 bytes; a caller-supplied id is rejected for v10                                           |
| Trust program          | upstream `TrustedNetwork({ id })`       | `SharedFsTrustGraphV10` (section 2.3), id `sha256(id \|\| "/shared-fs/v10-merkle-v1/trust")`              |
| Entry root             | `SharedFsEntry` (`model.ts` L27)        | `SharedFsEntryV10` (abstract, fieldless)                                                                  |
| Content blocks         | `shared_fs_file_chunk`                  | `shared_fs_merkle_data_block_v1`, `shared_fs_merkle_tree_block_v1` (merged, unchanged)                    |
| File version           | `shared_fs_file_version`                | `shared_fs_v10_bound_version`, an envelope around the canonical `MerkleFileVersionV1` bytes (section 2.2) |
| Naming                 | `shared_fs_naming_event`                | `shared_fs_v10_naming_event` (v9 fields plus `storeId`)                                                   |
| Snapshot pointer       | `shared_fs_bootstrap_manifest`          | `shared_fs_v10_bootstrap_manifest`                                                                        |
| Changeset manifest     | `shared_fs_changeset_manifest`          | `shared_fs_v10_changeset_manifest`                                                                        |
| Index row              | `shared_fs_indexable_entry`             | `shared_fs_v10_indexable_entry`                                                                           |
| Snapshot format        | `SNAPSHOT_FORMAT_VERSION = 1`           | 2, with the v10 segment entry type                                                                        |
| Changeset manifest fmt | `CHANGESET_MANIFEST_FORMAT_VERSION = 1` | 2                                                                                                         |

v10 makes the merged, fieldless `MerkleContentEntryV1` extend
`SharedFsEntryV10`, so one `Documents<SharedFsEntryV10, IndexableSharedFsEntryV10>`
dispatches every kind. **A4:** re-parenting under another fieldless,
variant-less abstract class keeps every golden vector byte-identical and
abstract dispatch working; the TypeScript and Go golden tests must prove it in
S1. If not, v10 wraps blocks in an envelope as it already wraps versions.

`IndexableSharedFsEntryV10` combines the v9 row columns (`parentId`, `name`,
`deleted`, `causalRefs`, `causalDepth`, attribution, `changesetId`) with the
`IndexableMerkleEntryV1` columns (`blockRefs`, `leafSize`, `rootLevel`,
`treeLevel`, `contentRoot`), adds `publishedAt`, and drops `chunkRefs` and
`contentHash`. Content rows use the merged derivation, so `blockRefs` never
comes from author input. New kinds: `merkle-data` and `merkle-tree`.

The program also serializes, as part of the address:

- `defaultLeafSize: u32`. New files use it, patches inherit their base's leaf
  size, and readers accept any allowed size (D1, D10).
- `sealedIgnoredNames`, exactly as v9 (migration copies the source list,
  section 8.3).
- `predecessor?: { address, captureDigest }`, set only by migration. It lets
  v10-aware peers authenticate a successor marker (section 8.5).

### 2.2 Store binding and replay

Peerbit's log entry metadata (`Meta`: `clock`, `gid`, `next`, `type`, `data`,
per `@peerbit/log` `entry-v0` in the installed cohort) does not bind the log
address, so any reader can re-deliver a signed entry into another log.

**Between generations.** Distinct variants make every v9 payload undecodable
in v10 and the reverse. Without them, a replayed, superseded v9 naming event
with a preserved node id could become a fresh naming head in v10 and resurrect
a deleted path.

**Between v10 filesystems.** Migration preserves node, naming, and version ids,
and several flows create more than one destination from one source (an M6
abort, rollback before cutover, a re-run, a rehearsal). A replayed head from
another destination would become an extra head, or even the winning head when
its stored depth is higher (rollback after v10 writes, then re-migration).
v10 therefore binds every signed metadata document to its store:

- `NamingEventV10` carries `storeId` (the v10 program id).
- A file version is stored as a `SharedFsBoundVersionV10` envelope with
  fields `id`, `storeId`, `publishedAt`, and `versionBytes`. `versionBytes` is
  the canonical encoding of a `MerkleFileVersionV1`, decoded only through the
  merged strict entry point `decodeMerkleContentEntryV1()`. `id` must equal
  the inner version id.
- `canPerformEntry` rejects any naming event or bound version whose `storeId`
  differs from this program's id. Manifests already bind `storeId`.
- Blocks are not bound: they are self-certifying, and replaying one is
  harmless.

`publishedAt` is the signed time at which the version document was first
published in this store. For an ordinary write it equals `createdAt`. For a
migrated version it is the migration time, while `createdAt` keeps the
original value. It feeds the witness rule (section 3.5).

### 2.3 Trust domain separation

v9 uses upstream `TrustedNetwork`. Its `IdentityRelation` (`@variant(0)`, id
`sha256(serialize(to) || serialize(from))`, trusted-network 6.0.138
`identity-graph.ts` ~L143-184) carries no network or store binding. Put
admission (`controller.ts` `canPerformByRelation` ~L62-101) only requires the
signer to equal `relation.from` and to be trusted, and a first put stands
alone. So, if v10 kept that relation type:

- any root-signed v9 grant, including a grant later revoked in v9, would be
  admissible in a v10 filesystem with the same root key, and would re-trust a
  deliberately uncarried, revoked writer;
- a carried delegator's old v9 grants, including ones it revoked, would be
  admissible even under a new root;
- grants signed in any other filesystem by a key v10 trusts would be
  admissible. The CLI roots every filesystem it creates at the local identity
  (`cli/src/index.ts` ~L668-670), so this is the normal case;
- v10 grants would be admissible in the frozen v9 filesystem.

**Why not a time rule.** Revision 2 admitted a relation only if its log
entry's signed HLC wall time was at or after the filesystem's creation. That
does not hold. The wall time is author-asserted and unbounded at ingest: in
the installed `@peerbit/log` 6.2.35 the log's `HLC` has no maximum offset
(`log.ts` ~L833; `clock.ts` ~L116-201), every join pulls the local clock
forward to the received time, and an appender may supply any timestamp. One
future-stamped relation from any trusted v9 key moves every trust-log
replica's clock, so later v9 grants carry times after the v10 creation; a
fast root clock or a slow creator clock does the same. Time also cannot
separate filesystems.

**The design binds relations to the store:**

1. **`SharedFsTrustGraphV10` (S1).** An in-repo trust program with upstream
   `TrustedNetwork`'s semantics: a rooted graph; a relation is admitted when
   its signer equals `from` and is trusted; only the signer of an edge can
   delete it; trust is reachability from the root. Its relation,
   `TrustRelationV10 { storeId, from, to }`, has its own variant and an id
   derived from the store id and both keys, and is admitted only when
   `storeId` equals this filesystem's program id. Consequences:
    - no v9 relation decodes in v10, revoked or not, whatever its timestamp;
    - no relation from another v10 filesystem is admitted, even one signed by
      the same root key;
    - v10 relations do not decode in v9, so trust relations cannot move in
      either direction;
    - `trustedWriters()` and `isTrusted` use a breadth-first walk keyed by
      public key, so the upstream path-generator issue (U3) does not affect v10.

    **A10:** the in-repo program can reproduce the upstream semantics v9 relies
    on (admission, owner-only delete, reachability); S1 tests them against the
    upstream behavior.

2. **Upstream.** trusted-network 6.0.138 already contains network-bound v2
   primitives (`v2.ts`: `TrustedNetworkV2`, network ids from
   `deriveNetworkIdV2`), but only as a decode-only codec that cannot be opened
   and is not exported. U2 asks for it to be finished. If it lands before S1,
   v10 can use it instead of the in-repo program (D22).
3. **Residuals.** Within one filesystem, whether a revoked relation's original
   put can be re-delivered after its CUT depends on upstream `Documents` CUT
   semantics; v10 inherits v9's exposure (noted under U2). A writer trusted in
   both generations can still make native grants in the frozen v9 filesystem:
   v10-aware releases refuse them there (section 8.5), v9-only peers admit
   them, and `late-writes` lists them. They never reach v10.
4. The trust program's id is derived with a domain tag (section 2.1), so a
   caller-supplied program id can never make v10 share the v9 trust log.

### 2.4 How a peer tells v9 from v10

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

### 2.5 Hard rule: no silent reinterpretation

- Neither generation's code deserializes the other's program or admits the
  other's documents or trust relations. One v10 filesystem admits no signed
  metadata or trust relation bound to another.
- Opening a v9 address never migrates it. Migration is an explicit command
  that produces a new address.
- Migration opens the source with scheduled GC and automatic snapshot
  publishing disabled (section 8.3). Its only writes to v9 are the root-signed
  freeze, successor, and thaw markers, lockdown revocations (section 8.8), and
  any other revocations the owner chooses. Guard D on the migrating replica
  may still re-put a removed live head, which does not change the captured
  semantic state.
- S1 tests:
    - v10 payloads rejected by v9 ingest and the reverse;
    - a signed v9 naming entry replayed into v10 rejected;
    - a naming event, version, or trust relation bound to another v10 store
      rejected, including a grant signed by the same root key in another
      filesystem;
    - every v9 relation rejected by v10: a revoked root-to-X grant, a carried
      delegator's grant, and a grant signed after the root's clock was pulled
      forward by a future-stamped relation;
    - a v10 relation rejected by v9;
    - v9 program bytes and addresses unchanged (byte-for-byte fixture);
    - unknown program variants fail with the typed error.

### 2.6 Implementation strategy

v10 must not fork the 14.7k-line `index.ts`. S0 extracts an internal
content-layer seam from `SharedFileSystem` with no behavior or wire change:

- content publication (`touchChunks`, version construction in `writeFileInner`
  and `writeBatchInner`);
- content reads (`fetchChunk`, `readFileVersion`);
- the GC heal and sweep content steps;
- the disposal content closure (`captureDisposalClosure`);
- the Guard D content branch (`guardAgainstLiveRemovals`);
- the entries change listener's content-kind predicates (~L3038-3121), as one
  generation-supplied predicate. It drives the disposal moving-view counter
  (`disposalContentGeneration`), readiness evidence, `docsSinceSnapshot`,
  overlay `removedMetadata`, and `applyCacheChanges`. In v10, naming events,
  bound versions, data blocks, and tree blocks all bump the disposal counter;
  readiness evidence and overlay retirement stay metadata-only, as v9 excludes
  chunks.

Naming, trust, lifecycle, readiness, bootstrap, caches, and conflicts move to
an abstract, variant-less base class; the concrete v9 and v10 classes declare
their own Borsh fields.

Other modules that must learn the v10 classes: `watch.ts`, `ignore/policy.ts`
(`instanceof FileVersion`), `changeset.ts`, `mount-backend.ts`, and
`IgnoreAwareFs`, which must wrap `patchFile` and `openVersionRangeForMount`
with the same commit-time ignore guard it applies to `writeFile`.

## 3. Write path

### 3.1 Commit protocol

This extends the order in MERKLE_STORAGE_V1.md ("Patch publication"). One
internal commit serves `writeFile`, `writeBatch`, `patchFile`, and mounts:

1. Copy, validate, sort, and coalesce ranges before the first `await`. Mount
   commits hand over their frozen, immutable overlay buffers without a second
   copy.
2. Take local version leases (root descriptor included) on the content base
   and every observed head (section 5.1); a mount state also holds a lease on
   its open base (section 4.3).
3. Check the path and expected node (the existing
   `SharedFsExpectedNodeMismatchError` checkpoints `initial` and
   `base-version`).
4. Build with `MerklePatchBuilderV1` (#329/#339) in deferred-put mode: the
   builder computes the new root and returns a block plan without putting
   anything. It reads base tree blocks to compare leaves by position, and base
   data only for leaves that a write covers partly. A full-coverage write
   (section 3.3) reads no base data, and starts from the empty root if a base
   tree it needs is unavailable.
5. **No-op.** If the new root descriptor equals the base descriptor and the
   observed heads are unchanged, return `unchanged`. Nothing is put, and
   nothing beyond step 4's reads is fetched.
6. Classify every block the new version references with the rules of section
   3.5: new (put), reused and reached by a young version (skipped), or reused
   without a young witness (re-put). An unwitnessed untouched subtree is read
   from the local store; if any of it is unavailable, the commit fails with
   `EIO` before anything is published.
7. Put the new and re-put blocks. Data blocks go with bounded concurrency (4,
   like v9's `CHUNK_IO_CONCURRENCY`) or as one blocks-only `putMany` (S3
   measures both; A11); each tree block goes after its children. A partial
   failure leaves only unreachable or already reachable blocks, so it is
   crash-safe.
8. Recheck the expected node (`before-version`).
9. Put the bound version last, as `unique`.
10. R4 (section 3.5): recheck presence and re-put from memory.
11. For a new file, append the naming event (`before-naming`); for an existing
    file, run the `after-version` check.
12. Advance the caller's base and release leases no longer needed.

A crash before step 9 leaves only unreachable blocks, and a visible version
never precedes its new blocks. Every ingest recomputes `contentRoot` through
`assertMerkleFileVersionV1`.

### 3.2 In-place operations

A new library API exposes the builder, and the mount uses it (section 4.3):
`patchFile(path, { patches, size, expectedNodeId, baseVersionIds, noOpIfHeadVersionIds, signal })`.
It is **full-replica-only**, like MERKLE_STORAGE_V1's exact tree session; on a
partial replica it fails with `EINVAL` (section 3.6).

- **Overwrite:** partial leaves load and verify at most their base leaf;
  full-leaf overwrites skip the read.
- **Append:** a patch at or beyond the base size; the builder extends the old
  short final leaf when needed.
- **Truncate:** a smaller `size` drops whole subtrees without fetching them and
  rewrites only the boundary path.
- **Sparse growth:** a larger `size` without patches writes no data; the tail
  is authenticated zeros.
- **Truncate, then grow, in one commit** (including `O_TRUNC` followed by a
  rewrite). The commit builds once, against the original leased base, so every
  leaf is compared by position with it:
    - byte patches for every range written after the truncation;
    - a new, bytes-free zero-range patch kind for any part of
      `[floor, min(baseSize, finalSize))` that no later write covers, where
      `floor` is the lowest truncation point. Leaves it fully covers become
      authenticated absent children; partial leaves are zeroed after loading the
      base leaf;
    - `size = finalSize`.

    An in-place save that rewrites the whole file is a full-coverage write
    (section 3.3): no base data is read, an unchanged rewrite ends at the no-op
    with nothing put, and a rewrite that changes one leaf puts that leaf, its
    path, and a version.

- **Saves spread over several commits** (a shell redirection, where closing a
  duplicated descriptor flushes an empty file before the command writes, or an
  `fsync` midway). The mount state keeps its open base leased for its whole
  life and compares every commit against it as well as against the latest
  committed version (section 4.3), so unchanged bytes are not re-put.
- **Chaining.** Dirty sets beyond one build's limits (1,024 patches, 64 MiB of
  patch bytes, or 4,096 changed leaves by default; mounts use the defaults)
  are committed as ascending, disjoint builds, each over the previous
  intermediate root. Outside its own range each intermediate root still holds
  the original base content, so positional comparison is preserved. The final
  size is applied by the last build, only the final root is published, and
  intermediate O(d) boundary blocks become orphans for GC.

Builder work needed in S3 (the builder is unmerged, D6): deferred-put mode with
a block plan (new, reused by position, untouched subtree), zero-range patches,
adoption of immutable patch buffers without copying, a second positional
comparison base (the open base), and the empty-root fallback for full-coverage
writes.

### 3.3 Full-content `writeFile` and the no-op rule

`writeFile(path, bytes)` keeps its signature. On a full replica it is a
full-coverage `patchFile`: one patch covering `[0, bytes.length)` and
`size = bytes.length`.

- Leaves are compared by position with the base using base tree blocks only;
  base data is never read. If a base tree needed for the comparison is missing
  or corrupt, the build starts from the empty root instead, and every block is
  classified by R2 and R3 (section 3.5). Either way the new version's parents
  are the observed heads, as today.
- Overwriting a damaged file therefore succeeds whenever the new bytes are
  available, as in v9, which never reads the base on a write. This is also how
  a user resolves a node whose tree is lost (section 5.6).
- New files build from the empty root. Migration uses a dedicated streaming
  builder (section 8.3).

The no-op rule replaces `contentHash` equality (`writeFileInner` ~L5064): a
write is a no-op when the built root descriptor (`size`, `leafSize`,
`rootLevel`, `rootHash`) equals the single current head's, decided before any
put (section 3.1 step 5). The native-mount exact-head no-op
(`noOpIfHeadVersionIds`) keeps its shape checks and returns
`mountWriteOutcome: "unchanged"`.

### 3.4 `writeBatch`

The ordering contract (`writeBatchInner` ~L5630) is unchanged: blocks for
every entry, versions (`putMany`, unique), the R4 recheck, naming (directories,
creates, deletes last), and the changeset manifest last. Blocks are not
manifest members, so the barrier stays metadata-only ("`readFile` may still
fetch bytes remotely"). Per-entry atomicity and non-atomicity across entries
are unchanged. Batch-wide block dedup uses one bounded in-memory id set. The
changeset id prefixes `shared-fs-freeze:`, `shared-fs-thaw:`, and
`shared-fs-successor:` are reserved and rejected with `EINVAL` in v10-aware
releases, for both generations.

### 3.5 Dedup rules that replace W1 and W2

**v9's rule.** W1 (`touchChunks`, ~L4603) skips a chunk put only when a version
younger than the skip horizon (15 days, `DEFAULT_SKIP_HORIZON_MS`, ~L366)
references the chunk, on any node and at any position. GC clamps retention to
at least `skipHorizon + max(grace, 48 h)` (`retentionFloor`, ~L13589). A young
witness cannot be retired by any replica for at least
`retention - skipHorizon`, so what it references stays referenced everywhere
while the new version propagates. Otherwise W1 re-puts the chunk from memory.
v9 applies W1 only to the chunks of the new version, and only after its no-op
checks (~L5039-5069 and ~L5504-5524), so no-op writes and opens put nothing.

**v10's rule** applies the same bound to every block the new version
references. A _young version_ is one whose `publishedAt` is within the skip
horizon. Every replica's arrival time is at or after `publishedAt` (section
2.2), and retirement (`ageOk`, ~L13663) needs both `createdAt` and arrival to
be older than retention, so a young version is unretirable everywhere for at
least `retention - skipHorizon`. Migrated versions are young for 15 days after
migration (D15). The same clock assumptions as v9's W1 apply.

- **R1, positional reuse (no queries).** A block equal to the block at the same
  position in a leased version of this commit (the base or, for a mount state,
  its open base) is covered when that version is young: it is neither put nor
  fetched. This covers untouched subtrees and leaves rewritten with identical
  bytes.
- **R2, new blocks.** A block that is absent locally is put `unique`.
- **R3, witness climb (W1, generalized).** A block that is present but not
  covered by R1 (a stale leased version, a shifted position, a copy, or an
  atomic save to a new node) is skipped only if a young version reaches it.
    - The climb follows `blockRefs` reverse edges upward (present tree rows, then
      version rows). It is memoized per commit and bounded like Guard D: depth at
      most 7, at most 64 referrers per step, at most 1,024 rows visited.
    - If it finds no young version, or hits a bound, the block is re-put with
      `putPreferLinked`, which refreshes its arrival age and links the live head,
      like v9's unwitnessed re-put.
    - For an untouched subtree only its root is checked, because a young version
      that reaches the root reaches the whole subtree. An unwitnessed untouched
      subtree is read from the local store and re-put in full; if any of it is
      unavailable, the commit fails with `EIO` and publishes nothing.
    - Leaves rewritten with identical bytes are re-put from the patch bytes,
      never fetched.
- **R4, post-publication recheck (W2).** After the version put, `hasDocument`
  for every block this commit put and every leaf rewritten with identical
  bytes; a missing one is re-put from memory. This keeps v9's W2 repair of a
  lost chunk that a rewrite happens to cover.

Scope and cost:

- Nothing runs before the no-op decision, and a writable open puts nothing.
- A 4 KiB edit over a young base uses only R1 and R2: no queries for untouched
  content.
- The first commit, other than a no-op, whose reused content no young version
  reaches re-puts that content (section 1.5). v9 re-puts the same number of
  chunks from memory; v10 reads the untouched ones locally first.
- An atomic save or a copy of a large file with a small change puts the
  changed blocks, the root path, the version, and the naming event, and runs
  one memoized climb per block that already exists (about `d + 1` index
  queries each, **A12**), where v9 runs a witness query per chunk.
- Conflict resolution and `restore` apply the same rules to the version they
  point at. For resolution this is stricter than v9, which reuses `chunkIds`
  without any check.

`dedup: "off"` disables R1 and R3: every block the version references is put
(O(file)), matching v9's partition-proof mode. Partial replicas also disable
R1 and R3 (section 3.6).

### 3.6 Partial-replica writers

v9 re-puts every chunk on a partial replica, so `keep: "self"` retains the
writer's own content (`touchChunks` ~L4603; `keep` ~L2980). Partial replicas
run neither GC nor Guard D. v9 permits partial writers: a creator with
`replicate: false` is write-ready (~L2623), and `allowPartialWrites` makes an
address open write-ready. In v10:

- `writeFile` and `writeBatch` on a partial replica put every block of the new
  version from caller memory (O(file), v9 parity). R1 and R3 are disabled.
- `patchFile`, `openVersionRangeForMount`, and v10 writable mounts are
  full-replica-only (`EINVAL`). The CLI mount already refuses
  `--no-replicate` (`cli/src/index.ts` ~L939).
- Conflict resolution and `restore` on a partial replica fetch (verified) and
  re-put the selected closure, or fail with `EIO`.
- S2 adds a partial-writer retention test.

### 3.7 What a version references

A `MerkleFileVersionV1` (#336) carries `id` (`version:` plus 32 random bytes),
`nodeId`, `parentVersionIds`, the stored `causalDepth`, `size`, `leafSize`,
`rootLevel`, `rootHash?`, `contentRoot`, advisory `createdAt`, `authorKey` and
`machineLabel`, `conflictResolution`, `changesetId?`, and `legacyWholeSha256?`
(set only by migration). Its envelope adds `storeId` and `publishedAt`. It
references zero or one block, its root, and its size is independent of `F`.
That removes v9's ceiling of about 8,000 chunks per version (about 4 GiB at
the default chunk size).

`contentRoot` is the content identity. Public results report it as
`contentHash: "merkle1:" + base64url(contentRoot)`, a prefix that can never
equal a v9 SHA-256 string, plus `legacyWholeSha256` when present (D5).

### 3.8 Leaf size

The proposed default is 512 KiB (D1):

- **Documents per commit.** At about 3 ms per put, document count dominates
  small and medium commits. A 1 MiB rewrite puts 4 documents at 512 KiB,
  against v9's 3, and 6 at 256 KiB (section 1.5). The only measured 64 KiB
  layout (the local-only adaptive-range branch) regressed sequential reads,
  writes, and opens.
- **Parity with v9.** A 4 KiB edit writes one 512 KiB leaf, like v9's minimum
  chunk re-put. Cold random reads fetch 512 KiB (128x), also like v9. Migration
  maps v9's default chunks to leaves one to one.
- **What 256 KiB would buy:** half the write and read amplification for small
  random I/O. It becomes the better default only if bounded-concurrency or
  batched block puts (A2b, A11) bring the 1 MiB rewrite within the gate.

S8 decides between 512 and 256 KiB. If both pass every gate, choose 256 KiB
(lower amplification). If only one passes, choose it. If both fail, choose the
one closer to the gates and escalate the per-put cost upstream (#18). 64 KiB
remains an allowed layout, not the default.

### 3.9 Bounds

The merged codec and builder bounds apply unchanged: wire at most 2 MiB,
fanout 256, depth at most 6, at most 8,000 parents per version, and the
builder's default and absolute limits. `writeBatch` keeps its 10,000-entry
limit and 12,000-member manifest cap.

## 4. Read path

### 4.1 Block source and read concurrency

`MerkleDocumentsBlockSourceV10` implements `MerkleBlockSourceV1`: a local
`entries.index.get` by `data2:`/`tree2:` id, then a remote fetch with the retry
budget and backoff of today's `fetchChunk` (~L5840); absence returns
`undefined`. The read session copies and verifies every result; a missing,
corrupt, wrong-type, wrong-level, or wrong-length block fails with `EIO`. A
bounded process-wide LRU of verified blocks keyed by id can safely be shared
across sessions, because blocks are self-certifying. A cached block is never
evidence that the store still holds it (section 3.5 decides availability).

The merged `MerkleReadSessionV1` reads leaves one at a time
(`merkle-read-session-v1.ts` ~L536-580), where v9 fetches four chunks at a
time. S2 adds a `fetchConcurrency` option (default 4) for multi-leaf reads,
and the mount adds a bounded sequential read-ahead: after two consecutive
leaves are read, up to two more are prefetched into the verified cache.

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
`base`, with its root descriptor, and on the opened heads), and `layers` (a
mutable top layer plus at most one frozen commit layer). `length`,
`mutationGeneration`, `persistedGeneration`, `committing`, and the namespace
fields are unchanged.

**Open.**

- A read-only open resolves the entry, confirms `sameFileSnapshot`, takes the
  lease, and creates the session. It reads no data.
- A writable open without `O_TRUNC` also verifies the root block and the
  rightmost root-to-leaf tree path, and checks that the final leaf is present
  (appends extend it): O(depth) local reads. If any is missing it fails with
  `EIO`; v9 fails the same open, because it reads the whole file.
- A writable open with `O_TRUNC` verifies nothing, as v9 skips the read
  (`loadWritableSnapshot` ~L1840). Its commits are full-coverage writes.
- No writable open puts anything, whatever the base's age. The witness rule
  runs only in a commit that is not a no-op (section 3.5).
- The state's first base is its **open base**. It stays leased for the life of
  the state, and every commit compares its leaves by position against it as
  well as against the latest committed version (R1).

**`write()`** stays synchronous. It computes the offset (`O_APPEND` uses
`state.length`), copies the data into the top layer's sorted range map
(newest wins, overlaps split), updates `length`, and bumps the generation.
With no `await`, the documented append-allocation invariant (`backend.write`,
~L2481) holds. For every leaf a write covers only partly, the backend queues a
background prefetch-and-verify of that base leaf and its tree path (bounded
queue and concurrency). A failed prefetch marks the state `baseUnavailable`,
so the next `write`, `flush`, or `fsync` fails with `EIO` early, before more
data is accepted.

**`read()`** plans synchronously and awaits only immutable bytes. Before its
first `await` it resolves the requested range into segments:

1. a range written in a layer returns a copy of its bytes (newest layer first);
2. an offset at or above that layer's truncation floor returns zeros;
3. otherwise the next older layer is consulted;
4. what remains is served by the base: the `session` captured at planning time,
   zeros beyond the base size.

It then awaits only those base segments. This keeps v9's property that a read
is atomic with respect to `write`, `truncate`, and commit.

**`truncate`** (`resizeState`) sets `length`, clips the top layer's ranges,
and lowers its truncation floor.

**`flush`, `fsync`, and `release`** keep `localCommit(state, cutoff, trigger)`.
At commit start, synchronously:

1. freeze the top layer and open an empty one;
2. flatten the frozen layer into ascending, non-overlapping byte patches, zero
   patches for uncovered truncated ranges, and the final size (section 3.2);
3. commit through `patchFile`.

Committing past the cutoff is allowed, as today: `commitNow` snapshots the
current generation (~L1400-1415). On success, a new session is created for the
new base. The old session stays open, and its version leased, until the reads
that captured it drain. The frozen layer is dropped and `persistedGeneration`
advances.

**Saves spread over several commits.** Because every commit also compares
against the open base, a save that truncates, commits, and then rewrites
unchanged bytes puts nothing for those bytes while the open base is young.
Examples are `cmd > file`, where the shell closes the duplicated descriptor
and so flushes an empty file before the command writes, and an explicit
`fsync` midway through a save. When the open base is stale, R3 applies as for
any other commit.

**On commit failure, the merge rule** folds the frozen layer back without
resurrecting truncated bytes:

- keep the top layer's ranges;
- add the frozen ranges clipped to `[0, top.floor)`, minus the top ranges;
- set `floor = min(frozen.floor, top.floor)`;
- keep `length`.

This gives, for every offset, the same result as reading through the two
layers separately.

**A commit that keeps failing.** Transient errors (`EAGAIN`, retryable remote
fetches) retry up to three times with backoff inside the commit. On a
permanent failure (`EIO` on a required base block, `EROFS` if the owner
chooses the spill option of D19, or a CAS loss, which v9 already makes
terminal), the backend:

1. returns the error to `flush`, `fsync`, or `release`;
2. on a failed `release`, which Linux FUSE never retries, spills the dirty
   ranges, zero ranges, final size, node id, path, and base version id to a
   recovery file under the Peerbit directory, and logs a loud error;
3. releases the lease;
4. lists the file in `status --json` (`recovery`).

`peerbit-fs recover list|apply <file>` re-applies a recovery file through
`patchFile` against its recorded base, so a moved head becomes a conflict, not
an overwrite. Stranded and live leases are reported in `status --json` with
their ages. A memory-mapped reader of an unavailable block gets `SIGBUS`, as
for any read-time `EIO`.

**No-op.** A built descriptor equal to the base, with unchanged opened heads,
returns `unchanged` with no document put (section 3.1 step 5), as v9 does at
~L1441.

**Memory** is at most the top layer, plus the frozen layer, plus one build's
working set (the verified-tree cache, at most 32 MiB by default, and the
deferred new blocks, at most one build's changed leaves). Only dirty bytes are
held, so the worst case (the whole file rewritten while a commit of the whole
file runs) matches v9's worst case of a live buffer plus a detached commit
snapshot, and the common case is far smaller.

**Handshakes.** For v10 targets, `mountWriteSemantics()` returns
`"merkle-exact-head-patch-v1"` and `mountReadSemantics()` returns
`"merkle-verified-exact-range-v1"`. Namespace semantics
(`"node-guarded-namespace-v1"`) are unchanged. As `mountNamespaceSemantics()`
does today, a target advertises the v10 strings only when `patchFile`,
`openVersionRangeForMount`, `writeFile`, and `readVersion` are all the
library's own methods, or an `IgnoreAwareFs` wrapper of them. Otherwise the
backend falls back to the whole-file path (read the version, commit with
`writeFile`), which is O(file) but correct. `status --json` reports the active
path (`"merkle-patch"` or `"whole-file"`).

### 4.4 Semantics preserved, and what changes

Preserved: exact-version mount reads without ancestor substitution, the CAS
through `expectedNodeId` and `expectedParentNodeId`, publishing a concurrent
head on a head mismatch (never a rebase), per-state commit serialization, the
conflict virtual paths, and read atomicity.

Changed:

- A read-only open no longer fails with `EIO` when a block is unavailable; the
  read that needs the block does.
- A writable open without `O_TRUNC` fails only if the root or the rightmost
  path is unavailable. A partial write whose base leaf or path turns out to be
  unavailable fails later: at the next write or `flush` after a failed
  background prefetch, or at commit. v9 fails such files at open instead.
- An `O_TRUNC` open and a full-coverage write never need base data, so they
  succeed on damaged files, as in v9.
- A partial write over a stale base whose untouched, unwitnessed content is
  unavailable fails with `EIO` (R3). v9, holding the whole buffer, re-puts that
  content from memory.
- A base block can also disappear after open, when remote GC retires a
  superseded base; leases, the lease-aware mark, and Guard D protect the local
  replica against that (section 5), at the cost of re-put churn.
- A commit never publishes over a base whose required blocks could not be
  verified.

D11 decides whether writable opens should verify more at open.

## 5. GC and physical reclamation

### 5.1 Retention, the retention floor, and leases

Version and naming retirement (`planDag`, ~L13701) and its keep set (the
newest `keepVersions`, anything younger than `retentionMs` or `graceMs`, pins,
delete-observed and recoverable versions) are unchanged. The retention floor
(`retention >= skipHorizon + max(grace, 48 h)`, ~L13589) is carried into v10
unchanged, because the witness rule depends on it.

v10 adds reference-counted **version leases**. A lease carries the version id
and its root descriptor. Range sessions, mount states, stranded commits, and
in-flight commits hold them. A lease has no TTL and is released by `close()`,
by a recovery spill, or by lifecycle close; `status --json` reports every
lease with its age. Leases affect GC in three places:

- leased version ids join the keep set (local retirement);
- leased roots are marked even when their version row is absent (section 5.2);
- Guard D re-puts a removed version row that is locally leased, and a climb
  that reaches a leased root counts as retained (section 5.4).

The 60 s `pinVersions` TTL (~L12035) remains for short library reads.

### 5.2 Heal, then mark after retirement

1. **Heal** (before retirement, as v9's pass at ~L13986). For every version
   planned to survive, walk its root closure with bounded concurrency and a
   memo set. Resolve tree blocks locally, or heal them by a verified remote
   fetch, and check them (`assertMerkleRootBlockV1` for the root,
   `assertMerkleChildLevelV1` for the rest). Data blocks get only an index
   presence probe, healed by a verified fetch when missing; reads and the
   explicit scrub verify bytes.
    - An unhealable missing data block marks its node **damaged**.
    - An unhealable missing or corrupt tree marks its node damaged and sets
      **`sweepBlocked`** for the run, because the tree's descendants are unknown
      (section 5.6).
    - As in v9 (~L14043-14061), damage exempts the node from retirement and
      purge, with one change: a damaged version that is no longer a head
      follows the normal retirement rules, so resolving the file lets it retire
      (section 5.6).
2. **Retire** undamaged nodes' planned versions and naming events, then settle,
   as today.
3. **Mark** (after retirement settles). The mark is the union of the closures
   of every version row still present, including damaged nodes' versions and
   versions planned for retirement but not retired, plus every leased root. It
   extends the heal walk's memo, so shared subtrees are visited once. A missing
   data leaf hides nothing, so it never removes the rest of a closure from the
   mark.

Cost: O(present versions + distinct reachable trees) document reads plus
O(distinct reachable data blocks) index probes; memory is the memo set, the
same order as v9's `owners` map.

### 5.3 Sweep

- **Candidates:** `merkle-tree` and `merkle-data` rows older than
  `chunkGraceMs` by arrival time (`__context`) and absent from the mark.
- **Ledger** (a new `blockCandidates` map with `firstSeenMs`, as v9's
  `chunkCandidates`):
    - A candidate is recorded only by a complete, unblocked run.
    - It leaves the ledger in any run where it is marked, has a present
      referrer that is marked or is a version row, or is younger than
      `chunkGraceMs` by arrival (for example after an R2 re-put).
    - It is deletable only in a later complete, unblocked run with
      `firstSeenMs <= runStartedMs - blockOrphanSpanMs` and
      `firstSeenMs <= ledger.lastRunMs`, as v9's `spanReady` (~L14137).
    - Blocked runs neither record candidates nor count as observations.
- **`blockOrphanSpanMs = max(configured, minOrphanSpanMs, 48 h)`**, a clamp
  with a report warning in the style of `retentionFloor`. Scheduled runs cannot
  lower it (it is not on `GC_SCHEDULED_RUN_OPTION_ALLOWLIST`, ~L320). The 48 h
  is defense in depth (section 5.5), and lowering the floor is D12.
- **Before each delete, a live veto** (restoring v9's sweep-time live-refcount
  semantics, ~L14180-14230). Candidates are processed top-down: trees by
  descending level, then data. A candidate is deleted only if every present
  referrer returned by the `blockRefs` index is a tree already deleted earlier
  in this run, and no leased root reaches it (the lease registry is
  snapshotted at sweep start).
    - Any present version row, any present tree not deleted in this run, or any
      leased root vetoes the delete.
    - A vetoed tree vetoes its whole subtree for this run.
    - A candidate vetoed by a version row or a marked tree leaves the ledger;
      one vetoed only by an unmarked tree that was not deleted (an orphan still
      waiting) just waits.
- **Delete** through the H0-verified path of `deleteChunkVerified` (~L13424),
  which resolves the bytes first and restores the block if the CUT hit an
  unexpected head. Sweep deletes are never added to `gcSuppressed` (v9
  parity), so the local Guard D backstops the veto.
- `chunkSweep: "immediate"` stays a manual-only bypass.
- **Report fields:** `deletedTreeBlocks`, `deletedDataBlocks`,
  `reclaimedBlockBytes` (logical), `markedTreeBlocks`, `probedDataBlocks`,
  `vetoedBlocks`, and `sweepBlocked` with a reason.

Unreachable blocks at every level become candidates in the same run, and the
top-down order deletes a whole orphan subtree in one executing run once each
of its blocks is span-ready.

**Offline replicas.** v9 notes that the barrier "verifies temporal span, not
convergence" (~L11862-11866): a replica returning after weeks offline holds
matured candidates. v10 inherits v9's peer-evidence gate (~L11857-11880).
Whether to also re-record candidates whose recording run is more than two
schedule intervals old is D20.

### 5.4 Guard D for blocks

`guardAgainstLiveRemovals` (~L12153) gets a block branch, coalesced in the
existing 300 ms window like versions:

1. Skip a removed block that is suppressed or whose id does not match its
   content.
2. Climb reverse edges: present rows whose `blockRefs` contain the id, plus
   removed values from the same burst.
3. If any path reaches a present version row (not only a head, mirroring v9's
   "referenced by any present file-version row") or a locally leased root,
   re-put the removed blocks bottom-up with `putPreferLinked`.
4. Bound the climb: depth at most 7, at most 64 referrers per step, at most
   1,024 visited rows. An exceeded bound, a failed lookup, or an ambiguous
   answer re-puts every structurally valid removed block. The safe failure is
   retained garbage.

The version branch additionally re-puts a removed version row that is locally
leased, not only heads (v9's `flushGuardQueuesInner` ~L12257 restores only
heads). Arming, bootstrap disarming, and lifecycle generations are unchanged.

### 5.5 Safety argument

1. **Reused blocks.** A block the new version reuses without re-putting it is
   reached by a young version: through a leased base or open base by position
   (R1), or through a climb (R3). No replica can retire that version for at
   least `retention - skipHorizon` (the retention floor keeps that at least
   `max(grace, 48 h)`), so the block stays marked on every replica while the
   new version propagates. This holds under **A6**: a new version reaches
   every full replica within `retention - skipHorizon` of publication, the
   same assumption v9's W1 makes.
2. **Unwitnessed reuse.** Such blocks are re-put before the version is
   published, so the new version never depends on a stale witness (v9 parity).
3. **In-flight sessions.** A session's base can become stale, or be retired
   remotely, while it is open. The lease keeps its root marked locally, Guard D
   restores removed blocks and leased version rows, and the commit applies the
   witness rule at commit time. If content it must re-put is no longer
   available, the commit fails with `EIO` and the dirty ranges are spilled
   (section 4.3). Nothing broken is published.
4. **Late arrivals during a sweep.** The live veto (section 5.3) rejects a
   delete that any version row or live tree still reaches, including a version
   that arrived after the mark.
5. **Defense in depth.** The 48 h minimum orphan span, Guard D on every replica
   that holds the new version, and GC heal from peers.

Conclusion: under A6 and v9's clock assumptions, GC deletes no block that is
reachable from a present version row or a leased root. The one deliberate
exception is `abandon-version` (section 5.6): it retires a superseded, broken
version early, removing that version itself on every replica.

### 5.6 Unhealable trees: blocking and the exit

A missing tree hides its descendants, and deleting them would turn a
recoverable loss (the tree may be healed later from a peer) into a permanent
one. So an unhealable missing or corrupt tree under a present version blocks
every block delete in the run (MERKLE_STORAGE_V1 blocked the whole sweep for
any incomplete root). Reachable causes include a writer that crashed after its
version replicated but before its blocks did, local corruption, and any
trusted writer publishing a version whose root never existed (ingest cannot
require a referenced block to be present).

Revision 2's exit let an operator abandon the unknown region while its version
was still present. That was unsafe: deletes are replicated CUTs, so one
replica's local loss would delete blocks that other replicas still reach
through the tree, and blocks shared between the lost region and retired
versions look exactly like garbage. The exit now removes the version instead
of guessing about its region:

1. **Resolve the file.** The user overwrites it (a full-coverage write needs no
   base data, section 3.3), deletes it, or resolves the conflict. The broken
   version V is then no longer a head. A damaged version that is not a head
   follows the normal retirement rules (section 5.2). Once V is retired, no
   present version references the lost tree, the mark no longer needs it, and
   the sweep unblocks by itself.
2. **Optionally retire V early.**
   `peerbit-fs gc abandon-version <address> <versionId>` is refused while V is
   a head. Otherwise it records, in the replica's GC ledger, that V may be
   retired in the next run regardless of `keepVersions`, retention, and grace.
   The retirement is a replicated CUT of V's row: it removes that superseded
   version on every replica, including replicas where it is intact. That is
   history loss the operator accepts explicitly; the current head is never
   touched. The record is cleared if the tree heals first.
3. **Alerting.** After 4 consecutive blocked runs (about a day at the default
   6 h interval), GC emits `gc:error` and `status` shows the blocking version,
   the tree, whether V is still a head, and the command to use. GC never
   abandons anything automatically (D17).

The liveness cost remains: while V is still a head, block reclamation stays
blocked on every full replica until someone resolves the file, and after
that, until V retires (at least the retention window) unless the operator
abandons it.

S5 tests: overwriting a head whose root tree is missing succeeds without base
data; the sweep unblocks after V's normal retirement, and immediately after
`abandon-version`; a second replica that holds the tree keeps the current head
and every block the head reaches.

### 5.7 Other interactions

Snapshot segments hold only naming and version heads, so segment ledgers,
`store-exclusive` raw-block reclamation, and Guard D arming are unchanged.
Physical reclamation is unchanged too: GC deletes `Documents` entries and does
not promise disk compaction. GC still requires a full replica, and unknown
kinds are never deleted.

## 6. Snapshots, bootstrap, readiness, and disposal

### 6.1 Snapshots and bootstrap

v10 segments (format 2) contain naming heads and full bound-version heads,
including tombstones, never blocks. The manifest payload binds the v10 program
id as `storeId`. The overlay serves version documents; blocks are fetched
lazily through the block source and verified. A missing, corrupt, unknown, or
wrong-level block fails with `EIO`; only an authenticated absent child reads
as zeros. Overlay retirement, the write gate, and Guard D arming keep their
fail-closed order, and a partial replica cannot open a lease-backed session.

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
data, tree, version, naming, and trust counts separately.

The moving-view rejection now covers blocks: additions and removals of naming
events, bound versions, data blocks, and tree blocks all bump
`disposalContentGeneration` (section 2.6). Without that, a block-only CUT and a
Guard D re-put during the fence (which re-creates the block under a new log
hash) could certify receipts for entries that no longer exist. Cost stays
O(live closure), the same order as v9. The guard-settled check and per-entry
receipt semantics are unchanged. S6 adds a disposal run that races a
block-only CUT and expects `EIO` with a retry-safe result.

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
U1 for full-replica writers, and the FUSE gain does not depend on it.

**U1 (upstream, relayed through the owner): a persisted-root session, or
retained-root lease.** A leader verifies and retains an authenticated root
closure, then accepts a successor root plus changed blocks and atomically
advances the lease. The receipt then means "this leader holds all of
`C(V_k)`" at O(delta) per step. Only a future opt-in remote-durable commit mode
needs it; no slice here is blocked on it.

## 7. Conflicts, naming, trust, and ACLs

**Unchanged:** the per-node causal DAG and its stored-depth-then-id head order;
two patches on one base yield two heads even when their ranges are disjoint;
no automatic merge; `resolveConflict` publishes a version over all heads; the
naming CRDT, every `resolveNamingConflict` action, and `merge-directory`; the
rooted, transitive trusted-writer graph and non-retroactive revocation; no
reader ACL and advisory `authorKey`; changeset barrier semantics.

**Changed:**

- Conflict-resolution versions are constant-size and point at the selected
  root (v9 copied `chunkIds`, ~L6318). Under the witness rule (R3), resolving to
  a version no young version reaches re-puts its blocks; v9 does not re-put
  there.
- The `restore` action publishes an O(1) version when the restored head is
  reached by a young version, and re-puts its blocks otherwise, matching v9's
  re-put (`touchChunks(chunkDocs, "off")`, ~L8044) in that case.
- Trust relations are bound to their filesystem (section 2.3). Migrated trust
  is flattened (section 8.6, D13).
- `contentHash` changes meaning (section 3.7, D5).
- The content-equality leak moves to leaf and subtree granularity, and omitted
  zero leaves reveal which leaf-aligned ranges are all zeros.
- A frozen v9 filesystem refuses new writes in v10-aware releases (section
  8.5).

## 8. Migration from v9

### 8.1 Principles

One-way freeze-and-copy to a new, store-bound address. The v9 filesystem is
retained read-only. No dual write and no mixed log. Every step can be re-run
against the same capture; a changed capture requires a fresh destination. A
fresh peer verifies the result before the address is distributed.

### 8.2 Tool and CLI shape

The library exports `migrateSharedFsV9ToV10(options)` and
`verifySharedFsMigration(options)`. The CLI is experimental until S8:

```text
peerbit-fs migrate plan        <v9-address> [--leaf-size 512KiB] [--history heads|retained] [--json]
peerbit-fs migrate freeze      <v9-address>
peerbit-fs migrate run         <v9-address> --state <file> [--leaf-size ...] [--history ...]
                               [--trust carry-flat|carry-direct|none] [--min-acks <n>] [--quiet-ms <ms>] [--json]
peerbit-fs migrate verify      <v9-address> <v10-address> --state <file> [--fresh-dir <dir>] [--json]
peerbit-fs migrate cutover     <v9-address> <v10-address> --state <file>
peerbit-fs migrate thaw        <v9-address> <freeze-id>
peerbit-fs migrate lockdown    <v9-address> --state <file> [--all | --keys <key>...]
peerbit-fs migrate late-writes <v9-address> --state <file> [--apply <v10-address>] [--revoke <key>...] [--json]
peerbit-fs migrate revoke-carried <v10-address> <public-key> --state <file>
peerbit-fs recover list|apply  <recovery-file>
peerbit-fs gc abandon-version  <address> <version-id>
```

`plan` changes nothing. It reports:

- counts, live bytes, and the projected time, disk, and network cost;
- the source's `sealedIgnoredNames`;
- the trusted-writer set, with at most three example delegation chains per key
  (the shortest paths found by the section 8.6 walk; paths are never
  enumerated);
- every head that cannot be converted, with the reason (section 8.4).

### 8.3 Procedure

1. **M0, preflight.** Open the source as a v9 full replica with `gc: false` and
   `snapshot: { disabled: true }`. Require `awaitWriteReady` with no bootstrap
   overlay, a settled resurrection guard (the `throwIfDisposalGuardUnsettled`
   condition), and, on access-controlled filesystems, the **v9 root identity**,
   which alone can sign markers (section 8.5) and flattened grants. As with
   `prepare-disposal`, any mount process using the same Peerbit directory must
   already be stopped; the tool cannot detect every such process. Fail if
   `plan` finds unconvertible heads, unless the owner-approved options of
   section 8.4 are given.
2. **M1, freeze and capture.**
    1. The operator quiesces every mount and writer on every machine, and
       disables scheduled GC on every v9-only replica (v10-aware replicas
       suspend it once they see the freeze).
    2. Publish the root-signed freeze marker (section 8.5) with
       `migrate freeze`, which `run` calls when no freeze is active.
    3. Wait for a quiet window (`--quiet-ms`, default 60 s) without filesystem
       or trust arrivals.
    4. Capture the **semantic state**: every naming head (id and document
       content hash, which covers a tombstone's `observedContentHeads`), every
       content head (id and document content hash), and the trust relation set
       (from, to). Persist the full capture set and its digest in the `--state`
       file, together with the ids of every naming and version row present,
       heads or not, which `late-writes` needs to find the ancestry of later
       changes (section 8.8).
    5. If the migration outlasts the freeze's expiry (section 8.5), `run`
       publishes a fresh freeze before it expires.

    Retiring non-heads or re-putting an identical value does not change the
    captured state. A purge of a deleted file does, and aborts at M6; re-run.

3. **M2, create the destination.** A v10 program with a fresh id, the chosen
   `defaultLeafSize`, the source's `sealedIgnoredNames` copied exactly,
   `predecessor = { v9 address, capture digest }`, and a root key (D14). The
   migration opens it with `gc: false` until M7 passes, and operators who open
   it early must do the same.
4. **M3/M4, convert and publish, one head at a time.** For each content head of
   every file node, including nodes whose naming winner is a delete (heads of
   tombstoned nodes carry delete-vs-edit recoverability):
    1. stream the v9 chunks in order through `MerkleStreamBuilderV1` (a
       right-frontier builder: each node hashed and written once, memory one
       chunk plus one leaf plus the tree frontier), verifying each chunk hash, a
       streaming whole-file SHA-256 against `contentHash`, and the byte count
       against `size`;
    2. put the head's blocks, then its bound version (ids, parent ids, stored
       causal depth, `createdAt`, attribution, `changesetId` preserved;
       `legacyWholeSha256` set; `publishedAt` = now), then run R4 for it.

    Heads with equal content share one root. Then publish every naming head
    (tombstones and conflicts included) as `NamingEventV10`, then a signed v10
    snapshot. `--history retained` also converts every retained non-head
    version, at O(retained bytes). Changeset and bootstrap manifests are not
    copied: they are inner-signed and bound to the v9 `storeId`. Absent
    historical parents are valid under the current DAG rules, so heads, winners,
    and conflict sets are preserved (**A7**, tested in S7).

5. **M5, resume.** The `--state` file records per-head progress. A re-run with
   the same capture skips heads whose version is present, and re-probes the
   presence of their new blocks. A re-run whose capture differs must use a
   fresh destination; resuming into the old one is refused.
6. **M6, recheck the source.** Recompute the semantic state and diff it against
   the persisted capture. On any change, abort and list the moved entries.
7. **M7, verify** (section 8.7).
8. **M8, fence (optional).** With `--min-acks`, run `prepareForDisposal` on the
   destination. This needs v10-aware replicators (v9-only peers cannot open v10
   at all), so upgrade replicators first. After M8, remote leaders hold the
   destination.
9. **M9, cutover.** Recheck the semantic state against the capture once more
   (the window since M6 includes the O(total bytes) verify). Publish the
   root-signed successor marker (section 8.5) and print the new address.

### 8.4 Heads that cannot be converted

v9 ingest checks only id prefixes, `causalDepth >= 1`, and the changeset id
(`structurallyValidEntry` ~L2063-2068). `MerkleFileVersionV1` rejects much
more (`merkle-file-version-v1.ts` ~L31-45 and its validators):

- ids over 256 bytes, empty strings, missing `version:` prefixes;
- more than 8,000 parents, duplicate parents, a version naming itself;
- author keys or machine labels over 4 KiB;
- ill-formed Unicode, which v9's Borsh string decoding does not reject;
- a causal depth that breaks the parent rule (no parents means depth 1; any
  parent means depth at least 2). An honest v9 conflict-flow write whose base
  versions were all absent stores parents with depth 1 (`writeFileInner`
  ~L5081-5150).

Content can also fail: unrecoverable missing chunks (v9's damaged nodes), a
`contentHash` mismatch, or a `size` that differs from the bytes (v9 never
checks the author's `size`).

Policy (D16):

- `plan` lists every such head with its reason, and `run` fails closed by
  default, naming them.
- Ids, stored depths, and sizes are never rewritten, because winner order
  depends on stored depth.
- The only automatic transformation, behind `--drop-absent-parents`, drops
  parent ids that are absent in the source (and therefore never migrated).
  Head computation already ignores absent parents, so this cannot change heads
  or winners. Each drop is reported.
- A node whose content cannot be converted can be excluded only by an explicit
  `--exclude-node <nodeId>`. It stays in v9, is listed in the report, and
  verify expects it to be missing.
- `verify` reports every exception by name rather than as a bare mismatch.

### 8.5 Freeze, successor, and thaw markers

Markers are member-less v9 `ChangesetManifest`s (the only v9 document a
released peer admits and otherwise ignores), with reserved changeset id
prefixes:

| Marker    | Changeset id                                    | Published at |
| --------- | ----------------------------------------------- | ------------ |
| Freeze    | `shared-fs-freeze:<nonce>`                      | M1           |
| Successor | `shared-fs-successor:<freeze-id>:<v10-address>` | M9 (cutover) |
| Thaw      | `shared-fs-thaw:<freeze-id>`                    | on `thaw`    |

Rules in v10-aware releases:

- **Only the v9 root key counts.** A marker is honored only when its inner
  signer is the v9 trust graph's root. Any trusted writer, or anyone on an open
  filesystem, can publish a manifest with these ids through today's
  `writeBatch([], { changesetId, manifest: true })`, so a weaker gate would let
  them freeze peers or redirect writers. On a filesystem without a root key,
  markers are shown only as unverified hints: no `EROFS`, no successor.
- **Freeze.** A freeze is active from publication until a thaw names its
  manifest id or, if no successor names it, until it expires `freezeTtlMs`
  (default 7 days, D8) after its root-signed `createdAtWallMs`. While a freeze
  is active, on v10-aware replicas:
    - new writable opens, file mutations, and namespace changes fail with
      `EROFS`;
    - v9 GC retirement and sweeps are suspended; Guard D and heal stay active;
    - trust administration by the root (`authorizeWriter`, `revokeWriter`,
      `migrate lockdown`) stays allowed;
    - writable states already open when the freeze arrives keep committing
      (D19). Their commits are late writes, reported by `late-writes`, and
      `status` warns while any exist.
- **Successor.** `handle.frozen.successor` is shown only when the root-signed
  marker names an active freeze and the named v10 program's
  `predecessor.address` equals this v9 address. A successor makes its freeze
  permanent (no expiry). The program's `predecessor.captureDigest` is for audit
  and verification. Two or more verified successors form a conflict:
  read-only, no successor shown.
- **Thaw** names the freeze it cancels (causal, never by wall time).
- **One protected set.** Freeze, successor, and thaw markers are protected
  alike. v10-aware full replicas never sweep any of them, record all three
  kinds in a local sidecar, and re-put any of them from the removed value when
  a CUT removes one (event-driven, like Guard D).
    - A freeze or successor is enforced, and re-put, only after the replica's
      synchronization after reconnecting has settled (the existing
      write-readiness signal) without finding a thaw for it. Until then it is
      shown as unconfirmed and not enforced; write readiness gates writes during
      that window anyway.
    - An expired freeze is shown as a stale hint and is never enforced or re-put,
      so neither a lost thaw nor a replayed old freeze can bring it back.
    - `status` shows every freeze without a visible thaw, with the `migrate thaw`
      command.
- **Limits.** v9-only GC retires manifests, thaws included, after about 30
  days of arrival age (~L14279-14345), and a replica that never held a thaw's
  payload cannot learn it from the CUT. So markers converge for late joiners
  only while at least one v10-aware full replica that holds the whole set stays
  online. Without one, a late joiner may miss a freeze (D8), and a replica that
  holds a freeze and its successor but never saw a later thaw (a rollback
  after cutover, section 8.9) can re-freeze the filesystem; the operator then
  publishes a new thaw. A successor-less freeze cannot come back after its
  expiry.
- v9-only peers admit markers and surface them as empty changesets in
  `watchChangesets` and `changesetStatus`.

M6 abort leaves the freeze active until the operator thaws it or it expires.
Rollback before cutover thaws.

### 8.6 Trust carryover

- **Computing the set.** `trustedWriters()` (~L3743) calls upstream
  `getTrusted()`, whose path generator (`identity-graph.ts` ~L85-110) returns
  from the whole walk on a revisited relation. It can silently drop writers on
  diamond-shaped graphs, and loop on cycles when its cache misses (U3). The
  tool therefore computes the carried set with its own breadth-first walk over
  the captured relation edges, keyed by `publicKey.hashcode()`, in O(V + E).
- **Edges, not paths.** The state file records the captured edge set. `plan`
  and the report show at most three example chains per key (the walk's
  shortest paths). Paths are never enumerated: any trusted key can authorize
  any other, so meshed graphs are ordinary, and their simple paths grow
  factorially.
- **Modes** (D13):
    - `carry-flat` (proposed): the v10 root authorizes every carried key
      directly.
    - `carry-direct`: the root authorizes only its own direct v9 grantees; each
      delegator must re-grant its delegates in v10 after cutover. Topology
      survives, but writers are locked out until then.
    - `none`.
- **Flattening removes cascading revocation.** In v9, revoking root to A also
  untrusts every writer reachable only through A (`revokeWriter` JSDoc
  ~L3716-3727). After `carry-flat`, each such writer has a direct root edge, so
  revoking A leaves them trusted, and A can no longer revoke them.
  `migrate revoke-carried <v10-address> <key>` restores the cascade: it adds
  the key to a revoked set kept in the state file, then walks the captured v9
  edges from the root, skipping every key in that set, and revokes the v10
  root edge of every carried key the walk no longer reaches. That is one
  O(V + E) walk, and it handles a key with several delegators revoked one at a
  time.
- Under `carry-direct`, the root can revoke only its own direct grants;
  delegates re-granted in v10 by a delegator hang off that delegator's edges,
  so v10's own reachability cascades normally.
- Revoked keys are not carried, and no v9 relation can enter v10 (section 2.3).
- Trust changes after capture are listed by `late-writes`, never applied
  automatically (section 8.8).
- A v9 filesystem without a root key becomes a v10 filesystem without one.

### 8.7 Verification

`migrate verify` opens both addresses from a fresh Peerbit directory (full
replica, fresh identity, remote fetch enabled, `gc: false`, snapshot
publishing disabled), waits for v10 write readiness, and compares:

- `sealedIgnoredNames`, byte for byte, and `predecessor`;
- every visible path, node id, and kind; every naming head of every node,
  including tombstones and unreachable nodes, field by field; and
  `namingConflicts()`;
- every migrated version, field by field (every preserved field, including
  those of deleted nodes); per file, head version ids, the visible head,
  `size`, and `conflicts()`;
- every head's bytes, streamed through `readRange` into SHA-256 and compared
  with `legacyWholeSha256` and the v9 `contentHash` (O(total bytes)), and
  `contentRoot` recomputed from the signed descriptor;
- the trusted-writer set, recomputed independently on the fresh peer from v9's
  relation documents with the same breadth-first walk, against v10;
- counts of nodes, heads, tombstones, and conflicts, and every exception from
  section 8.4.

It emits a JSON report. Any unexplained mismatch exits nonzero and blocks
cutover.

### 8.8 Late writes

`migrate late-writes <v9-address> --state <file>` compares v9's current state
with the capture and lists:

- **Content and naming.** Every current naming or content head that was not
  captured, with its late ancestry: the rows reachable from it through parent
  ids that were not present at capture (the state file keeps the captured row
  ids). Rows that existed at capture, and GC retirement of old non-head rows,
  are not late writes.
- **Trust.** The effective trusted set, recomputed with the section 8.6 walk
  over v9's current relations, against the captured effective set: keys that
  gained trust and keys that lost it, each with the relation changes
  responsible. Revocations issued by `migrate lockdown` (recorded in the state
  file) are listed separately and never proposed for v10.

The result does not depend on which peer runs it, as long as that peer is a
converged full replica of v9.

`--apply <v10-address>` re-applies the late naming and version rows through
the M4 conversion, in topological order (parents first), keeping ids and
parent ids. Every late chain therefore ends at a captured row that exists in
v10 under the same id, so v10's heads match v9's, and a concurrent v10 edit
becomes a conflict, not an overwrite. A late intermediate that v9 has already
retired cannot be converted; it is reported, with a warning that its
descendant will show a spurious conflict with the captured head. v10-aware v9
replicas keep v9 GC suspended while frozen, and operators must keep scheduled
GC disabled on v9-only replicas until the last `--apply`, or until v9 is
disposed of.

Trust is never changed automatically. `--revoke <key>` applies one listed loss
of trust to v10:

- with `carry-flat`, through the `revoke-carried` computation, so a v9
  revocation of root to A also untrusts A's flattened delegates that have no
  other path;
- with `carry-direct`, by revoking the root's own edge; losses of delegated
  keys are listed for their delegators;
- with `none`, not at all.

Late v9 grants are listed and never applied, and they cannot be replayed into
v10 (section 2.3).

`migrate lockdown` is the D8 command for revoking v9 writers after cutover. It
runs on a frozen filesystem (trust administration is exempt from the freeze)
and records its revocations in the state file, so a later `late-writes` never
proposes them for v10.

On v10-aware v9 replicas, post-freeze arrivals also surface as an event-driven
`frozen.lateArrivals` status, with no polling.

Limit: a late write is detected only while some peer that received it still
holds v9 state and someone runs the command. After operators delete v9 state
(section 8.9), a write that lived only on a partitioned v9-only peer is lost.

### 8.9 After migration, and rollback

- **v9 is retained read-only.** v10-aware peers open it with
  `handle.frozen = { freezeIds, successor? }`, and it stays readable for audit,
  rollback, and `prepareForDisposal`. Its space is reclaimed only when
  operators delete its Peerbit state after accepting the cutover.
- **Rollback before cutover:** thaw. The destination can be discarded unless
  M8 ran; after M8, remote leaders hold it until their state is deleted. Its
  store binding keeps its entries out of any other v10 filesystem.
- **Rollback after v10 writes is manual and unsupported in the first release**
  (D18). There is no v10 export tool and no v10 freeze marker. The manual path:
    1. thaw v9, which works only on v9-line releases or v10-aware releases inside
       the compatibility window (D9);
    2. re-apply each v10-only change with v9 `writeFile` and `writeBatch` using
       `baseVersionIds` set to the captured v9 heads and `expectedNodeId`, so
       that concurrent v9 changes become conflicts;
    3. accept that v10's intermediate causal history is lost and that v10 writers
       are not stopped by anything but operations.

    Files larger than about 4 GiB need a raised v9 `chunkSize` and whole-file
    memory.

### 8.10 Mixed-version fleets

| Peer release                      | Opens a v9 address                                              | Opens a v10 address                                                            |
| --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Current v9 releases (0.13.x)      | read-write; admits markers as empty changesets                  | fails at program decode with a raw Borsh error (cannot be fixed retroactively) |
| v9-line bridge release (proposed) | read-write; optionally honors root-signed markers               | explicit `SharedFsUnsupportedGenerationError` naming the minimum version       |
| v10-aware (proposed next minor)   | read-write in the window unless frozen; read-only after it (D9) | read-write                                                                     |

Upgrade every replicator to a v10-aware release before M8 and cutover.

### 8.11 Mounts during migration

Mounts must be stopped for capture and copy. A v9-only mount that keeps
writing is caught by the M6 or M9 recheck, or after cutover by `late-writes`.
A v10-aware mount that was open when the freeze arrived keeps committing its
open states (section 8.5), and those commits are also late writes; new opens
are read-only with a warning. After cutover, operators remount with the new
address. S7 tests a freeze that arrives while a v10-aware mount holds dirty
state, followed by `flush` and `release`.

### 8.12 Time and space

Notation: `L` is the distinct live head bytes, and `N` and `V` the naming and
content head counts. `--history retained` adds the retained non-head bytes.

| Phase            | Work                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Read and verify  | read `L`; hash about `2L` (chunk ids, streaming whole-file SHA-256)                                                              |
| Build and put    | hash about `2L` (leaf ids, post-sink check); put about `L/B` data and `L/(256B)` tree documents, `V` versions, `N` naming events |
| Verify           | fetch `L` to the fresh peer; hash about `2L`                                                                                     |
| Destination disk | at most `L` plus ~`32L/B` tree bytes (0.006% at 512 KiB) plus index rows; zero leaves are omitted                                |
| Peak disk        | the v9 store plus the destination, until v9 state is deleted                                                                     |
| Each replica     | downloads about `L` again, because v10 blocks differ from v9 chunks                                                              |

**A8:** migration runs at 30 MiB/s or more. At 512 KiB leaves, the fixed put
cost alone (2 data documents per MiB, about 3 ms each, serial) bounds
throughput near 160 MiB/s (about 80 MiB/s at 256 KiB). The size-dependent part
of a put is unmeasured. At 30 MiB/s, 10 GiB takes about 6 minutes to copy
plus a similar verification pass; S7 measures the real rate. Pre-seeding
replicas by local conversion (blocks are deterministic from content) is out of
scope, because the entries would be signed by different keys.

## 9. Rollout

### 9.1 Slices

Each slice is one reviewable PR with its own tests and changeset, and v9 stays
green on the strict three-OS gate after every slice.

**S0. Content-layer seam in v9.** Includes the change-listener predicates
(section 2.6). No wire or behavior change.

- Tests: v9 program-bytes and address fixture; entry wire fixtures; full
  strict suite; benchmark within 1.05x.

**S1. Generation identity.** The v10 program, salt, entry root and variants,
store-bound naming and versions, the v10 index, strict v10 ingest,
`SharedFsTrustGraphV10` with store-bound relations, the generation probe,
`handle.generation`, and typed errors. Rebases the #329 builder and the #339
hashing fix (D6).

- Tests: the section 2.5 tests (both directions, cross-store, revoked,
  delegated, clock-skewed, and same-root trust replay); the trust program's
  semantics against upstream `TrustedNetwork` (A10); golden vectors unchanged
  after re-parenting (A4); probe errors (A5).

**S2. Library content.** The `Documents` block source and sink, read
concurrency, `writeFile`, `writeBatch`, `readFile`, `readFileWithVersion`,
`readRange`, R1-R4 with the witness rule and climb, the partial-writer path,
the empty-root fallback, and the no-op before any put. Adds the opt-in
`generation: "v10"` create.

- Tests: crash injection at every publication boundary; randomized byte-oracle
  tests; exact and available reads; conflict convergence; stale bases (a no-op
  puts nothing, a full rewrite puts only the new version's blocks, a partial
  edit re-puts only unwitnessed reused blocks); an atomic save and a copy put
  only changed blocks; overwriting a damaged file succeeds; R4 repairs a lost
  leaf covered by an identical rewrite; partial-writer retention; climb cost
  (A12).

**S3. Patches.** Builder changes (deferred puts with a block plan, zero-range
patches, adopted buffers, the open-base comparison), `patchFile`, version
leases, chained builds, bounded-concurrency or `putMany` block puts, and work
counters.

- Tests: zero whole-file hash bytes; flat 4 KiB patch cost from 4 MiB to
  1 GiB (library); an in-place rewrite puts only changed leaves; put
  concurrency measured (A2b, A11).

**S4. Mount.** The v10 open state, writable-open verification, background
prefetch, the layered overlay with its merge rule and synchronous read
planning, recovery spill and `peerbit-fs recover`, the v10 semantics strings
and their fallback, and the harness work of section 9.4.

- Tests: `mount-backend` suites parameterized over both generations;
  byte-oracle tests with commit failures interleaved with truncate, write, and
  concurrent reads; native smoke; the Linux FUSE profile against section 9.3.

**S5. GC.** Heal, mark after retirement, the block ledger, the live veto, the
lease-aware mark and Guard D, retirement of non-head damaged versions, and
`abandon-version`.

- Tests: randomized GC, read, write, and CUT races; a node with one unhealable
  leaf keeps all its other blocks for three runs past the orphan span; a
  version arriving after the mark vetoes deletion; a leased base retired
  remotely stays readable; a blocked sweep unblocks after the file is resolved
  (normal retirement and `abandon-version`); a second replica holding the
  lost tree keeps the head and every block it reaches.

**S6. Snapshots and disposal.** v10 snapshots (format 2), overlay block fetch,
readiness evidence, and the disposal closure walk with block-aware moving-view
rejection.

- Tests: the cold-start, bootstrap, and `durable-disposal` suites on v10;
  disposal racing a block-only CUT; the process-crash suite.

**S7. Migration.** The library and CLI: markers, semantic capture with row
ids, the conversion policy, trust carry and `revoke-carried`, the verifier,
`late-writes` with ancestry and trust listing, and `lockdown`. The v9-line
bridge is a separate PR.

- Tests: ids, winners, conflicts, tombstones, sparse and large files; resume
  and fresh-destination refusal; source-moved abort; unconvertible-head
  fixtures (including conflict writes with absent bases); custom and empty
  `sealedIgnoredNames`; diamond, cyclic, and dense (50-key mesh) trust graphs
  in O(V + E); a key with two delegators revoked one at a time; forged markers
  ignored; a freeze while a mount holds dirty state; freeze, thaw, a v9-only
  GC sweep, then an offline replica reconnects without re-freezing; two
  sequential late writes to one file, a two-step rename, and edit, edit,
  delete, applied without spurious conflicts; a post-capture v9 revocation of
  root to A listed, then applied with `--revoke`, untrusting A's flattened
  delegates; `lockdown` followed by `--apply` leaves v10 trust unchanged;
  bounded-memory conversion of 1 GiB.

**S8. Promotion.** Both generations in the three-OS matrix, the FUSE
comparison, the leaf-size decision, and docs.

- Gate: section 9.3. The create default flips only on owner approval (D3).

### 9.2 Opt-in

Until S8 is approved, v10 is created only with `generation: "v10"` (library)
or `--generation v10` (CLI), and `peerbit-fs migrate` requires
`--experimental`. Opening an existing address needs no flag, because the
address determines the generation. `SHARED_FS_EXPERIMENTAL` stays `true`.

### 9.3 Acceptance criteria for promotion

**Method.** Every performance gate is computed within one job: v9 and v10
mounts interleaved in the same job (v9, v10, v10, v9 passes), all base sizes in
the same job, at least 50 samples per scenario per pass, and the exact
lockfile. Cross-job ratios are not used; between the two unprofiled jobs of
section 1.1, size-independent scenarios differed by up to 2.3x. This replaces
MERKLE_STORAGE_V1's "same machine, sequential ten-run" method (section 11).

**Strict CI:** Ubuntu, macOS, and Windows, both generations, no retries, no
timeout inflation.

**Structural counters** (MERKLE_STORAGE_V1 gates, sharpened):

- patch commits over a young base report zero whole-file hash bytes;
- base data fetched is at most one leaf per changed leaf, plus one truncate
  boundary leaf;
- data blocks put are at most the leaves that differ from the original leased
  base at the same position; an unchanged in-place `O_TRUNC` save of a 32 MiB
  file puts zero documents, and one with one changed leaf puts at most one
  data block, `d` trees, and one version;
- an `O_TRUNC` save spread over two commits (`sh -c 'cat src > dst'`, and a
  save with an `fsync` midway) puts no data block for unchanged leaves;
- an atomic save (temporary file plus rename) and a copy of a 32 MiB file with
  one changed leaf put at most one data block, the path trees, the version,
  and the naming event;
- a writable open with no write, and an unchanged save of a stale 32 MiB file,
  put zero documents; a full rewrite of a stale file puts at most the new
  version's blocks and the version;
- new tree blocks are at most the unique dirty ancestors;
- encoded version size is flat from 16 MiB to 1 GiB;
- random 4 KiB reads fetch at most one leaf per touched leaf;
- peak memory is bounded by the top and frozen layers plus one build's working
  set and configured caches.

**Linux FUSE:**

| Metric (p50 unless noted)                                     | v9 today          | v10 gate                                                                                      |
| ------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| 4 KiB overwrite in 32 MiB (young base)                        | 431-481 ms        | <= 60 ms and >= 8x faster than v9 in the same job                                             |
| 4 KiB overwrite, 32 MiB / 4 MiB, same job                     | 10.7x (cross-job) | <= 1.5x                                                                                       |
| 4 KiB overwrite, 512 MiB / 4 MiB, same job                    | not measured      | <= 2x                                                                                         |
| `mount.localCommit`, 32 MiB / 4 MiB, same job                 | 11.1x (cross-job) | <= 1.5x                                                                                       |
| Open plus first cold random 4 KiB read, 512 MiB / 4 MiB       | not measured      | <= 1.5x                                                                                       |
| 32 MiB overwrite per-sample `fsync` p95                       | 391-535 ms        | <= 1.25x the same pass's `write-1048576` `fsync` p95, and >= 3x lower than v9 in the same job |
| stat, readdir, read 4 KiB; create, stat, reopen 1-4 KiB files | baseline          | <= 1.10x (reads, metadata) and <= 1.15x (create, reopen) of v9                                |
| write 4 KiB (small file), 16 small files                      | baseline          | <= 1.15x and <= 1.10x of v9                                                                   |
| read 1 MiB, write 1 MiB                                       | baseline          | <= 1.25x of v9                                                                                |
| Sequential 8 MiB read, local and remote-backed                | not measured      | <= 1.25x of v9                                                                                |
| 500-file sequential cold open                                 | not measured      | <= 1.10x of v9, with no slow-mode tail                                                        |

The `fsync` gate is relative to the same pass's 1 MiB rewrite, because
small commits already show a p95 tail of about 110-165 ms that does not depend
on file size (`write-1048576` p95 123-164 ms in all 11 passes; `write-4096`
above 100 ms in 7 of 11). It comes from `Documents.put` (addendum:
`writeFile` p95 about 110 ms). v10 cannot remove it; it is traced separately
through upstream put diagnostics (#18).

**Correctness:**

- **Crash and reopen:** a kill after data puts, tree puts, the version put, or
  naming reopens to the old or the new version, never a partial one, and never
  `EIO` on reachable content.
- **Stranding:** a base block removed after a writable open never silently
  strands accepted writes: the commit fails with `EIO`, the dirty ranges land
  in a recovery file listed by `status`, and the lease is released.
- **Disposal:** persisted `minAcks` on all three OSes; recipients reopen alone
  with remote fetch disabled and verify every head's full closure; a
  block-only CUT during the fence fails closed.
- **Conflicts:** disjoint concurrent patches on one base give identical head
  sets on both peers; resolution versions are constant-size.
- **Corruption:** every leaf, tree, root, level, length, and missing-block case
  fails with `EIO`; available mode falls back exactly where v9 does.
- **GC:** no race removes a block reachable from a present version row or a
  leased root, including a remote CUT of the leased row; true orphans disappear
  after the barrier; a blocked sweep recovers once the file is resolved.
- **Replay and trust:** replay of entries and trust relations between stores
  (v9 into v10, v10 into v9, v10 into v10) is rejected, including revoked
  grants, grants signed after a forward-pulled clock, and same-root grants from
  other filesystems (MERKLE_STORAGE_V1's gate, restored).
- **Migration:** byte-exact, with ids, winners, conflicts, tombstones, sealed
  names, and the trusted-writer set preserved, verified from a fresh peer.

The comparator is v9 master in the same job. MERKLE_STORAGE_V1's comparison
with the local-only phase-1 flat-patch branch (`fa13d1e1`) is dropped, because
that branch requires #321 and is not on origin (D2).

### 9.4 Harness work and what to measure

`scripts/shared-fs-native-mount-benchmark.mjs` cannot produce these gates
today. It caps `--samples` at 50 and `--overwrite-base-bytes` at 32 MiB
(~L44-48), runs one base size per invocation, and the workflow offers only
4 MiB and 32 MiB (`shared-fs-native-smoke.yml` ~L16-23). Its overwrite offsets
are `(index % slots) * 4096` (~L663-667), so every sample lands in leaf 0 on
the leaf the previous commit just wrote, and an untimed full `readFile` after
each sample (~L677) warms caches. `read-4096` reads a whole 4 KiB file, not a
range inside a large one. S4 therefore adds:

- several base sizes, including 512 MiB, in one job, and v9 and v10 mounts
  interleaved in that job;
- seeded random overwrite offsets across the whole file, including
  leaf-crossing writes, and random 4 KiB range reads inside large files;
- a cold variant (fresh daemon or cleared caches, verification moved to the
  end);
- a higher sample cap, sequential 8 MiB reads (local and remote-backed), and
  the 500-file cold-open profile;
- an in-place `O_TRUNC` save of an unchanged and a one-leaf-changed 32 MiB
  file, the same save spread over two commits (`sh -c 'cat src > dst'` and an
  `fsync` midway), an atomic save, and a copy, each with counters for data
  blocks put;
- a writable open with no write, and an unchanged save, of a stale file;
- A9: confirm, with unprofiled same-job baselines, that runner variance allows
  the ratio gates.

Measure as well:

- #358 profiler phases plus new ones: `mount.target.patchFile`,
  `merkle.build`, `merkle.blockPut`, `merkle.versionPut`, `mount.lazyRead`,
  `mount.prefetch`;
- builder and reader counters for every commit and read session;
- GC reports: mark size, probes, vetoes, blocked sweeps, reclaimed blocks and
  bytes;
- migration throughput, peak RSS, peak disk, and verify time.

## 10. Risks, open decisions, assumptions, and upstream needs

### 10.1 Risks

- **Integrity bugs** in the builder or reader could corrupt data. Mitigated by
  golden vectors checked in TypeScript and Go, byte-oracle tests, `contentRoot`
  recomputed on every ingest, and fail-closed `EIO`.
- **The witness rule gives up v10's gain on idle files.** The first edit of a
  file whose reused content no version younger than 15 days reaches re-puts
  that content: the same puts as v9, plus a local read of the untouched part
  (D15).
- **Reclamation liveness:** one unhealable tree under a present version,
  including one a buggy or hostile trusted writer never published, blocks
  block reclamation on every full replica until the file is resolved and the
  broken version retires, normally or through `abandon-version` (D17).
- **Accepted writes can fail at commit** when a base block that a partial write
  needs disappears after open, or when a stale base's untouched content is
  unavailable (section 4.4). Recovery files prevent silent loss, but Linux
  drops `release` errors and applications often ignore `close` errors.
- **Document count per commit** is the main cost on Linux (about 3 ms per put).
  256 KiB leaves are projected to fail the 1 MiB write gate unless block puts
  overlap (D1).
- **Reverse-edge climbs** (R3) replace v9's per-chunk witness query for copies,
  atomic saves, and shifted content; their cost is A12.
- **Index growth:** tree rows carry up to 256 `blockRefs`, well under the
  indexer's roughly 8,191-row batch ceiling; data rows grow with `L/B`.
- **API meaning change** of `contentHash` for watch events, CLI output, and
  applications (D5).
- **Trust:** v10 needs an in-repo trust program until upstream finishes
  network-bound relations (A10, U2, D22). Flattening removes cascading
  revocation unless `revoke-carried` is used (D13). Replay of a revoked
  relation within one filesystem follows upstream CUT semantics, as in v9.
- **Freeze markers do not bind v9-only peers**, and converge for late joiners
  only while a v10-aware full replica holding the whole marker set stays
  online; without one, a lost post-cutover thaw can be undone (section 8.5).
- **Migration cost:** twice the disk at peak, and a full re-download on every
  replica.
- **Only Linux FUSE has been measured.** macOS and Windows mounts may differ;
  macOS evidence is blocked on macFUSE capacity.
- **Workload fit:** v10 helps in-place writers (databases, disk images, logs,
  editors that save in place) on files whose content a young version reaches.
  Atomic-save editors and copies put what v9 puts, plus reverse-edge queries;
  small-file workloads are unchanged. This is a product question.
- **The S0/S1 refactor** touches `index.ts` broadly; the v9 address-bytes and
  wire fixtures are the guard.

### 10.2 Open decisions for the owner

- **D1. Default leaf size:** 512 KiB proposed (4 documents per 1 MiB rewrite
  against v9's 3); 256 KiB if S3 shows concurrent or batched block puts bring
  it within the 1 MiB write gate; 64 KiB not proposed. Tie-break in section
  3.8.
- **D2. #321's zero-byte layout marker:** recommend dropping it for good and
  closing #321, since v10 gives lazy verified range reads natively without a
  v9 layout convention or mixed-version admission divergence. Reconsider only
  if v10 is delayed and read-only large-file opens matter meanwhile. Also
  confirm v9 master, in the same job, as the performance comparator.
- **D3.** When the create default flips to v10, and whether v9 creation is
  removed then.
- **D4. Program variant name:** `peerbit_shared_fs_v10_merkle_v1` proposed
  (MERKLE_STORAGE_V1 had the provisional `peerbit_shared_fs_merkle_v1`).
  Either works if never reused.
- **D5. Public `contentHash` in v10:** the `merkle1:`-prefixed content root
  plus `legacyWholeSha256` for migrated versions (proposed), or a new
  `contentRoot` field with `contentHash` left undefined.
- **D6.** Merge #329 and #339 (with S3's builder changes) in S1 or S3 as
  experimental exported API (about 104 KB unpacked), or keep them unexported
  until integrated.
- **D7. Migration UX:** explicit CLI only (proposed) or also a prompt on open;
  heads-only history by default (proposed) or all retained history.
- **D8. Freeze enforcement:** root-signed markers honored by v10-aware
  releases, plus late-write detection (proposed); additionally
  `migrate lockdown` of v9 writers after cutover on access-controlled
  filesystems (recommended where late joiners or v9-only peers remain); or an
  out-of-band announcement only. Also the freeze expiry (7 days proposed).
  Filesystems without a root key get hints only.
- **D9. Compatibility window:** how long v10-aware releases keep v9 read-write
  (proposal: at least two minor releases and at least 3 months after
  promotion); whether an unmigrated v9 filesystem ever becomes read-only in
  v10-aware releases or stays read-write indefinitely; whether the v9-line
  bridge release ships.
- **D10.** Leaf size fixed per filesystem in the program (proposed) or
  selectable per writer.
- **D11. Writable-open verification:** root plus rightmost path plus
  background prefetch, skipped for `O_TRUNC` (proposed); or the whole tree
  closure plus data presence at open (O(n) probes, about 0.27 ms each); or an
  opt-in `verifyOnOpen: "full"`. Read-only opens stay lazy.
- **D12. Orphan span floor:** 48 h, clamped (proposed). Lowering the floor is
  an owner decision backed by evidence, never an operator option.
- **D13. Trust carryover:** `carry-flat` with `revoke-carried` (proposed; loses
  cascading revocation unless `revoke-carried` is used), `carry-direct` (keeps
  topology; delegates locked out until re-granted), or `none`.
- **D14. v10 root key:** reuse the v9 root key (proposed; safe for trust replay
  in both directions once S1's store-bound trust program lands) or a fresh v10
  root key (the owner operates a second identity).
- **D15. Stale-base policy:** v9's witness rule for every block the new version
  reuses (proposed; migrated files are covered for 15 days after migration),
  or reuse anyway when the base is the sole local head on a write-ready
  replica (weaker than v9; relies on Guard D and heal).
- **D16. Unconvertible heads:** fail closed, with only `--drop-absent-parents`
  and explicit `--exclude-node` (proposed), or also allow rewriting invalid
  fields (breaks A7).
- **D17. Blocked-sweep exit:** resolve the file, then normal retirement or an
  explicit `abandon-version` of the superseded broken version, which removes
  that version on every replica (proposed); or also automatic abandonment of
  superseded broken versions after N blocked runs.
- **D18. Rollback after v10 writes:** manual and unsupported in the first
  release (proposed), or build a v10-to-v9 export and a v10 freeze marker.
- **D19. Freeze and live handles:** already-open writable states keep
  committing and are reported as late writes (proposed), or dirty states are
  spilled to recovery files with `EROFS`.
- **D20. Stale ledgers:** also re-record block candidates whose recording run
  is more than two schedule intervals old (beyond v9), or keep v9's
  peer-evidence gate alone (proposed).
- **D21. Dropped or changed MERKLE_STORAGE_V1 gates and method** (section 11):
  sign off.
- **D22. Trust program:** build the in-repo store-bound
  `SharedFsTrustGraphV10` in S1 (proposed), or wait for upstream network-bound
  relations (U2) and hold S1 until they ship.

### 10.3 Assumptions register

| Id  | Assumption                                                                                                               | Checked in                 |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| A1  | Ingest re-validation of local puts adds about `B` hashing per new data block                                             | S2 (counters)              |
| A2  | Measured: about 2.7-3.0 ms per `Documents.put` on the Linux runner; assumed roughly additive per document at these sizes | S3/S4 profiles             |
| A2b | Whether concurrent puts overlap in time (unmeasured; decides 256 against 512 KiB)                                        | S3                         |
| A3  | SHA-256 throughput is at least 300 MiB/s in the runtime                                                                  | S3 micro-benchmark         |
| A4  | Re-parenting `MerkleContentEntryV1` under `SharedFsEntryV10` keeps every golden vector and dispatch intact               | S1                         |
| A5  | The stored program's variant can be read before a full open                                                              | S1                         |
| A6  | A new version reaches every full replica within `retention - skipHorizon` of publication, as v9's W1 assumes             | S5 race tests; documented  |
| A7  | Absent historical parents preserve heads, winners, and conflicts after a head-only copy                                  | S7                         |
| A8  | Migration runs at 30 MiB/s or more                                                                                       | S7                         |
| A9  | Runner variance allows the section 9.3 ratios when computed within one job                                               | S4/S8 unprofiled baselines |
| A10 | The in-repo trust program reproduces the upstream `TrustedNetwork` semantics v9 relies on                                | S1                         |
| A11 | A blocks-only `putMany` resolves only after every item is committed locally, or reports which were                       | S3                         |
| A12 | An R3 climb costs about `d + 1` local index queries per present block, comparable to v9's per-chunk witness query        | S2                         |

### 10.4 Upstream needs (relayed through the owner)

- **U1.** A persisted-root session, or retained-root lease, for O(delta)
  full-version remote durability (section 6.4). Not blocking.
- **U2.** Network-bound trust relations, checked at admission, so grants
  cannot be replayed between trust networks. trusted-network 6.0.138 contains
  `TrustedNetworkV2` primitives with derived network ids, but only as a
  decode-only codec that cannot be opened and is not exported; the ask is to
  finish it. Related: document whether a revoked relation's original put can
  be re-delivered and re-admitted after its CUT. Until U2 ships, v10 uses the
  in-repo program (D22).
- **U3.** `getPathGenerator` (`identity-graph.ts` ~L85-110) returns from the
  whole walk on a revisited relation, dropping trusted keys on diamond-shaped
  graphs, and can loop on cycles when its cache misses. It should dedupe by key
  and `continue`. The same generator backs `isTrusted`, which can then fail
  closed. It still affects v9 and the migration's reading of v9 trust.
- **U4.** Bounded HLC wall time: the log's `HLC` has no maximum offset, and
  joins pull the local clock forward to any received time (`@peerbit/log`
  6.2.35 `log.ts` ~L833, `clock.ts` ~L116-201). v10 no longer depends on
  entry wall time for security, but anything that does inherits this.
- Existing asks from the 2026-09-27 list that matter more for v10: `putMany`
  all-or-none (#17) and put-phase diagnostics (#18).

## 11. Changes relative to MERKLE_STORAGE_V1.md

Refinements:

- Program variant `peerbit_shared_fs_v10_merkle_v1` (D4), a v10 variant for
  every entry kind, and store-bound naming and versions (section 2.2).
- A store-bound v10 trust program (section 2.3). This implements V1's "Do not
  blindly replay owner-authorized trust edges into a new trust domain", and
  restores V1's replay and revoked-writer release gate in section 9.3.
- A `SharedFsEntryV10` root and a combined v10 index row (section 2.1).
- The witness rule, dedup rules R1-R4, the partial-writer path, deferred puts,
  zero-range patches, and chained builds (sections 3.1-3.6).
- The mount overlay as synchronous, layered byte ranges with a truncation
  floor, a failure merge rule, synchronous read planning, writable-open
  verification, and recovery spill (section 4.3).
- GC: heal before retirement, mark after it; damaged nodes' versions marked; a
  live veto at sweep time (V1's "recheck reachability"); leases carrying root
  descriptors; a clamped 48 h orphan span; blocked sweeps that recover once the
  file is resolved, with an explicit early retirement (section 5).

Weakened or replaced, for owner sign-off (D21):

- **Leaf size:** V1 left the default open with 64 KiB as a latency profile;
  this document proposes 512 KiB, with 256 KiB conditional (D1).
- **Comparator:** v9 master in the same job, not the phase-1 flat-patch branch.
- **Method:** same-job interleaving with at least 50 samples per pass replaces
  "same machine, exact lockfile, sequential ten-run p50/p95". The exact lockfile
  is kept.
- **Kept gates:** random 4 KiB read amplification, sequential 8 MiB reads, 1 MiB
  writes, create, stat, and reopen of 1-4 KiB files, and the 500-file cold-open
  profile, all in section 9.3.
- **Replaced gates:** V1's "64 MiB 4 KiB overwrite 5x faster than phase-1" and
  "1 GiB p95 within 2x of 64 MiB" become the same-job 32 MiB and 512 MiB
  overwrite gates. The 1 GiB case stays a library-level S3 gate; S4 extends
  the mount harness only to 512 MiB, to bound CI job time and disk use.
- **fsync cutoff wording:** V1 said `fsync` commits "only mutations through
  that cutoff". The v9 fences it said to keep already commit past the cutoff
  (`commitNow`, ~L1400-1415), and v10 keeps that. This is a correction of
  wording, not a new behavior.

## 12. Revision notes

### Round 1

Revision 2 (after an adversarial review of revision 1, commit `e1e35e0d`; 27
verified findings). By finding number. Where the second round changed a fix,
its note below supersedes this one (notably items 1, 7, 9, 13, 15, and 21).

1. R1 now requires a young witness (base `publishedAt` within the skip
   horizon), the retention floor is carried unchanged, stale bases re-put their
   closure (v9 parity), the cost tables gained a stale-base row, A6 is restated
   from publication time, and migrated files are covered by `publishedAt` and
   D15.
2. The mark now covers every present version row, including damaged nodes'
   versions and unexecuted retirements, and runs after retirement; damage only
   exempts from retirement and purge; S5 test added.
3. The pre-delete rule is a live veto: any present version row, live tree, or
   leased root vetoes, and a vetoed tree vetoes its subtree; sweep deletes are
   never suppressed.
4. Leases carry root descriptors, leased roots are marked even without their
   row, Guard D re-puts leased version rows and treats leased roots as
   retained; section 5.5 and D11 rewritten.
5. `patchFile`, R1, and v10 mounts are full-replica-only; partial writers
   re-put every block (v9 parity); key decision 7 qualified; S2 test added.
6. Ledger rules specified (drop on mark or live referrer, complete unblocked
   runs only, `lastRunMs`), the 48 h is a clamped floor outside the scheduled
   allowlist, D12 recast, stale-ledger re-recording is D20.
7. Blocked sweeps now have an acknowledgement exit, alerting after four
   blocked runs, and a liveness risk entry; D17 added.
8. The change-listener predicates joined the S0 seam; blocks bump the disposal
   moving-view counter; S6 test added.
9. The trust store is domain-separated (genesis admission rule, fallback, U2);
   the "never replayed" claim is removed; the root-key default moved to D14;
   V1's replay gate restored; M0 requires the root identity.
10. Naming events and versions are bound to their store (`storeId`, bound
    version envelope); cross-store replay tests and gates added; a changed
    capture forces a fresh destination.
11. Markers count only when root-signed, successors are authenticated through
    the v10 program's `predecessor`, thaw names its freeze, multiple successors
    form a conflict, prefixes are reserved, and convergence is event-driven
    re-put with its limit stated.
12. The freeze (M1) and successor (M9) are separate markers; M6 abort and
    rollback behavior are stated; "nothing references v10" is corrected for
    M8.
13. The capture set is persisted, `late-writes` is a set difference over
    naming, versions, and trust, re-application keeps ids and parents,
    revocations are mirrored, the state is rechecked before cutover, and "never
    silently lost" is replaced by its real condition.
14. The source is opened with GC and snapshot publishing disabled, the capture
    covers semantic state only, and section 2.5 lists the remaining writes.
15. Flattening's loss of cascading revocation is explicit, delegation chains
    are recorded, `revoke-carried` and `carry-direct` are added (D13).
16. The carried and verified trust sets use the tool's own breadth-first walk;
    U3 added.
17. Live handles at freeze keep committing as late writes (D19); section 8.11
    corrected; S7 test added.
18. Rollback after v10 writes is manual and unsupported (D18), bounded by the
    window, with CAS re-application and the large-file note.
19. M2 copies `sealedIgnoredNames`; `plan` and `verify` report and compare it;
    S7 tests added.
20. Unconvertible heads are listed by `plan` and fail closed, with only
    reported, owner-approved transformations (D16).
21. `O_TRUNC` and truncate-then-grow build once against the original base with
    zero-range patches, the no-op is decided before any put, section 1.7 and
    the structural counters are corrected, and an in-place save scenario is
    gated.
22. Writable opens verify the root and rightmost path, partial writes trigger
    background prefetch, permanent commit failures spill to recovery files and
    release their leases, and G3, section 4.4, and D11 describe the new
    failure mode.
23. The `fsync` gate uses the scenario's own per-sample p95, relative to the
    same pass's 1 MiB rewrite; section 1.1 now says what the 307 ms and 857 ms
    figures were.
24. Harness work is part of S4, and every ratio gate is computed within one
    job.
25. Projections are re-derived from the measured ~3 ms per put; the default
    leaf size proposal moved to 512 KiB; block puts are concurrent or batched;
    the document counts are corrected (4 against 3, and 6 against 3 at 256
    KiB); A8 recomputed; a D1 tie-break added.
26. The failure merge rule and synchronous read planning are specified, and
    old sessions stay open until their reads drain.
27. Read concurrency and read-ahead are specified; the V1 read, cold-open, and
    reopen gates are restored; the vacuous writable-open gate is replaced;
    section 11 lists every dropped or changed V1 gate and the method change.

Low-severity notes also addressed: destination GC is off until verify, and
blocks and versions are published per head (migration GC note); v9 freeze
semantics for Guard D, heal, and GC are specified; all content heads,
tombstoned ones included, are migrated and verified field by field; replicator
upgrades before M8 and the v9-only view of markers are stated; the v9 behavior
changes are listed in section 1.4 and D9; caller-supplied v10 ids are rejected
and the trust id is domain-tagged; section 1.7 and the memory bound are
corrected, and chaining counts patches; `IgnoreAwareFs` wraps the new methods,
advertisement uses prototype identity, and the fallback path is reported.

Not acted on, because the review refuted them: that Guard D's suppression rule
contradicts v9; that the 1.10x and 1.15x gates are below measured noise (the
same-job method still addresses cross-job noise); and that the latency
projection rested on an unmeasured put cost (it was re-derived from the
measured cost anyway).

### Round 2

Revision 3 (after a second review of revision 2, commit `f7b67620`; 11 verified
findings, one further point refuted and not acted on). By finding number:

1. The no-op is decided before any witness re-put, writable opens put nothing,
   and the stale rule applies only to blocks the new version reuses:
   untouched subtrees are read locally and re-put, identical leaves are re-put
   from the patch bytes. Key decision 4, sections 1.4, 1.5, 1.7, 3.1, 3.5, 4.3,
   10.1, and D15 no longer overstate v9 parity; section 9.3 gained counters for
   a no-write open, an unchanged stale save, and a stale full rewrite.
2. Full-coverage writes read no base data and fall back to an empty-root build
   when a base tree is missing; `O_TRUNC` opens verify nothing; overwriting a
   damaged file succeeds, which makes the section 5.6 exit work; section 4.4
   and G3 list the remaining `EIO` cases.
3. Mount states keep their open base leased and compare every commit against
   it, so saves spread over several commits do not re-put unchanged bytes. R3
   generalizes v9's W1 to any present block through a bounded, memoized
   reverse-edge climb, so atomic saves and copies no longer re-put present
   blocks v9 skips. New counters and scenarios cover both, and section 1.4's
   claims are corrected.
4. The acknowledgement that swept an unknown region under a present version is
   removed. The exit is resolving the file (non-head damaged versions retire
   normally) plus an optional, explicit `abandon-version` that retires the
   superseded version early; section 5.5 names that one exception.
5. The time-based genesis rule is dropped: HLC wall time is author-asserted and
   unbounded, and forward pulls re-admit revoked grants. v10 uses an in-repo
   trust program with store-bound relations (A10, D22), with U2 and U4 as
   upstream asks. S1 tests cover forward-pulled and skewed clocks.
6. Store-bound relations also reject post-genesis grants from other
   filesystems with the same key, so key decision 2, sections 2.3 and 2.5, the
   9.3 gate, and D14 are now accurate.
7. `late-writes` diffs the effective trusted set, not edges, and `--revoke`
   applies a loss of trust with `revoke-carried` semantics under `carry-flat`;
   `carry-direct` and `none` are specified.
8. Trust changes are never mirrored automatically; `migrate lockdown` records
   its revocations, which `late-writes` never proposes, and trust
   administration is exempt from the freeze.
9. The capture records every row id, and `--apply` converts each late head's
   whole late ancestry in topological order; v9 GC stays off until the last
   `--apply`; retired intermediates are reported.
10. Freeze, successor, and thaw form one protected set; a freeze is enforced or
    re-put only after a settled sync finds no thaw; successor-less freezes
    expire after 7 days; `status` shows unthawed freezes; the remaining limit
    is stated.
11. The state file records edges, not paths; `plan` shows at most three example
    chains; `revoke-carried` is one O(V + E) reachability walk that also
    handles several delegators revoked one at a time.
