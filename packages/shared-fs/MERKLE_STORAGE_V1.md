# Merkle storage v1 proposal

Status: design proposal with the golden block codecs, strict file-version and
derived-index wire slice, an isolated read-only exact-range session, and an
isolated immutable path-copy builder implemented. Documents integration,
version publication, mount integration, migration, lifecycle leases, and the
upstream capability are not implemented.

This document specifies the next shared-fs content generation needed for
bounded-memory, block-granular random writes. It follows the fixed-layout lazy
read and phase-1 patch work, while preserving the existing namespace and
file-version conflict model.

## Decision summary

- Introduce a new top-level program generation and filesystem address. Do not
  attach Merkle-aware and legacy peers to the same entries log.
- Keep content blocks in a Peerbit `Documents` collection initially. This
  preserves trusted admission, replication, persisted-entry delivery, and
  recoverable CUT behavior.
- Replace the flat chunk manifest and whole-file SHA-256 with a sparse,
  content-addressed radix Merkle tree.
- Keep conflicts at immutable file-version granularity. Disjoint concurrent
  patches remain separate heads until an explicit resolution.
- Make normal commits O(changed blocks x tree depth). Full verification, GC,
  bootstrap repair, and disposal remain O(reachable blocks).
- Do not claim O(delta) full-version remote durability with the current
  per-entry receipt API. That stronger result needs the upstream capability
  described below.

## Why this needs a new address

The current generation stores every ordered chunk id directly in
`FileVersion`, hashes the complete file on each patch, and projects direct
`chunkRefs` into the index. GC, Guard D, and persisted disposal all rely on
those direct references.

A same-address tree extension is unsafe. A legacy peer could fail to decode a
new variant, could not interpret a root as file bytes, and would not include
transitive blocks in GC, resurrection, or disposal. A marker encoded as an
empty legacy chunk cannot carry an authenticated tree.

The implementation should therefore use both:

- a new top-level Borsh variant, provisionally
  `peerbit_shared_fs_merkle_v1`; and
- a new entries-store derivation salt, provisionally
  `/shared-fs/v10-merkle-v1`.

The exact generation number may advance before implementation, but the
top-level variant must still change. An old client must fail before attaching
to the new log. A new client may open the legacy generation read-only for
migration.

## Canonical content model

All hashes below are SHA-256 over canonical Borsh-encoded fields with the
literal domain prefix shown. Encoded integer widths and endianness must be
fixed by golden vectors before implementation. Hashes are stored as 32-byte
values internally and rendered as unpadded base64url in document ids.
Domain prefixes are literal UTF-8 bytes without a length prefix. An optional
root hash is encoded as one `u8` presence byte (`0` or `1`), followed by the
fixed 32-byte hash only when present.

The language-neutral fixtures live in `merkle-v1-golden-vectors.json` and are
verified independently by the TypeScript/Borsh and Go test suites.

### Data blocks

```text
MerkleDataBlockV1 {
    id: string
    bytes: Uint8Array
}

dataHash = SHA256(
    "peerbit-shared-fs/data/v1" ||
    u32(bytes.length) ||
    bytes
)

id = "data2:" + base64url(dataHash)
```

Rules:

- Supported leaf sizes are initially 64, 256, and 512 KiB.
- A normal patch inherits its base version's leaf size. Changing it is an
  explicit O(file) rechunk operation.
- A non-final present leaf is exactly `leafSize` bytes. The final leaf may be
  shorter.
- An all-zero leaf is omitted. An absent child in an authenticated tree means
  zeros; a missing referenced block never means zeros.
- A one-leaf file points directly to its data block, avoiding a tree document.
- Block bytes are copied before hashing or caching and are verified again on
  every untrusted fetch.

The 64 KiB layout is a latency profile, not an assumed default. Existing
measurements improved cold 4 KiB reads but regressed sequential reads, writes,
and opens. The promotion benchmark must choose the default; 256 KiB should be
included as the intermediate candidate.

### Tree blocks

Use a sparse radix tree with fanout 256.

```text
MerkleTreeBlockV1 {
    id: string
    level: u8
    bitmap: [u8; 32]
    children: Vec<Hash32>
}

treeHash = SHA256(
    "peerbit-shared-fs/tree/v1" ||
    level ||
    bitmap ||
    children
)

id = "tree2:" + base64url(treeHash)
```

`children` contains exactly `popcount(bitmap)` hashes in ascending slot order.
Slot `i` is bit `(i & 7)` of byte `(i >>> 3)`, least-significant bit first.
The hash preimage uses Borsh little-endian integers: the child vector carries
its `u32` element count, while each fixed 32-byte hash carries no length.
Level 1 points to data blocks; a level-N tree points only to level-(N-1) tree
blocks.
Empty nodes, duplicate slots, non-canonical ordering, and unknown levels are
invalid. Six levels cover the u64 file-size domain at the minimum leaf size.

Page indices are decomposed into big-endian base-256 digits. Path copying
rewrites only ancestors of changed leaves. Empty ancestors collapse. Suffix
truncation removes complete subtrees and rewrites only the boundary path;
sparse growth normally writes no data blocks.

### File versions and signed roots

Introduce `MerkleFileVersionV1` rather than widening the existing Borsh class.

```text
MerkleFileVersionV1 {
    id: string
    nodeId: string
    parentVersionIds: string[]
    causalDepth: u64
    size: u64
    leafSize: u32
    rootLevel: u8
    rootHash?: Hash32
    contentRoot: Hash32
    createdAt: u64
    authorKey: string
    machineLabel: string
    conflictResolution: bool
    changesetId?: string
    legacyWholeSha256?: Hash32
}
```

`rootLevel` is the minimum level capable of addressing `size`; level 0 means a
direct data root. `rootHash` may be absent only to describe an entirely
zero-filled file. Size remains authoritative for the final leaf and visible
EOF.

```text
contentRoot = SHA256(
    "peerbit-shared-fs/file/v1" ||
    leafSize ||
    size ||
    rootLevel ||
    rootPresence ||
    rootHash
)
```

`contentRoot` is the authoritative content identity. A conventional
whole-file SHA-256 is inherently O(file), so it must not be recomputed by a
patch commit. `legacyWholeSha256` is optional migration/provenance metadata,
not the no-op or integrity key.

The complete root descriptor is covered by the trusted Peerbit log-entry
signature. Bootstrap segments are covered by their trusted manifest signature.
Keep `authorKey` advisory: requiring equality with every outer signer would
prevent a trusted replica from re-publishing an immutable version during
recovery.

### Index projection

Create a generation-specific index projection with a derived `blockRefs`
vector:

- a version row references zero or one root;
- a tree row references at most 256 children;
- a data row references none.

Version rows retain the current node id, causal refs/depth, size, root/layout,
attribution, and changeset columns. Tree rows retain their level. `blockRefs`
must be derived from a structurally validated value rather than trusted as an
independent author-supplied mirror. This removes the current approximately
8,000-chunk version ceiling and provides reverse edges for Guard D.

Keep data and tree blocks in the entries `Documents` collection for the first
generation. Direct raw-block storage is a later optimization only after it can
provide equivalent authorization, replication, receipt, and reclamation
semantics.

### Implemented file-version/index wire slice

The library now exports `MerkleFileVersionV1` and
`IndexableMerkleEntryV1`. The file-version validator bounds every string and
parent vector, rejects malformed Unicode and inconsistent causal shapes,
requires a canonical root descriptor, and recomputes `contentRoot`; optional
legacy whole-file SHA-256 remains metadata only. Canonical
`merkleDataIdFromHashV1()` and `merkleTreeIdFromHashV1()` helpers map a verified
32-byte hash to its generation-specific document id.

`MerkleDataBlockV1`, `MerkleTreeBlockV1`, and `MerkleFileVersionV1` share the
fieldless `MerkleContentEntryV1` dispatch base. Untrusted complete content bytes
must enter through `decodeMerkleContentEntryV1()`; local index bytes must use
`decodeIndexableMerkleEntryV1()`. Both APIs preflight the exact raw variant,
enforce strict canonical UTF-8 and bounded custom Borsh fields before payload
allocation, validate the resulting semantic shape, and require byte-identical
canonical reserialization. Direct concrete-class Borsh deserialization is not
a supported boundary because its string discriminator is consumed without an
exact class-name comparison.

Index rows can only be constructed from a known Merkle v1 class. Root and
child `blockRefs` are derived from one copied, structurally verified snapshot;
callers cannot supply or race an independent reference list. A version has at
most one direct block edge, a tree has at most 256 distinct direct edges, and a
data block has none. The TypeScript/Borsh and independent Go tests share exact
file-version and index wire fixtures as well as the block/root hash fixtures.
Safe decoding of an existing index row establishes canonical row shape, not
the provenance of its reference mirror; consumers must reconstruct the row
from authenticated content before relying on `blockRefs` as trust evidence.

This is a wire boundary, not a live storage generation. Nothing in this slice
changes the current v9 program variant, address salt, `Documents` schema,
authorization hook, GC, snapshots, disposal, read/write path, or mount.

## Validation and authorization

Ingest validation must be structural and independent of local replication
order:

- reject unknown entry kinds by default;
- enforce id/hash equality, block-size bounds, bitmap/popcount equality,
  canonical child ordering, non-empty tree nodes, allowed layouts, canonical
  root level, version-parent bounds, and changeset bounds;
- do not require referenced children or parents to be locally present;
- enforce exact level-N to level-(N-1) tree transitions during traversal;
- bind snapshot and changeset payloads to the new store generation.

The current outer-entry trust-graph check remains the authorization boundary.
Content blocks are self-certifying but still require an authorized log put.
Revocation remains non-retroactive: old roots stay readable and recoverable,
while new puts from a revoked writer are rejected as trust state converges.

Security posture:

- Hash domains, layout ids, and codecs are fixed and downgrade-intolerant.
- Missing referenced blocks, wrong-length leaves, and unknown codecs fail with
  `EIO`; they are never interpreted as authenticated holes.
- Block payload, tree depth/fanout, causal-parent, dirty-range, logical-size,
  traversal, and cache bounds are enforced before expensive work.
- Compression is out of scope for v1, avoiding decompression-bomb and
  cross-runtime canonicalization risks.
- A corrupt local block is repaired only from bytes matching its content id.
- Content addressing retains the existing equality leak: a party able to query
  the filesystem can test whether known block content exists.
- A trusted writer can still consume its authorized share of storage. Merkle
  validation is not a quota system; deployment quotas remain an operational
  requirement.

## Implemented read-only session

`MerkleReadSessionV1` is the opt-in second implementation slice. It accepts a
copied root descriptor and an abstract asynchronous source of decoded data and
tree blocks. `read(offset, length, { signal })` walks only the intersecting
authenticated tree paths, clips at the signed logical EOF, and returns absent
authenticated children as zeros. The single-read allocation, verified tree
LRU, and verified data LRU all have explicit bounds. The configurable 64 MiB
single-read default is also subject to a fixed 256 MiB ceiling. `stats()`
exposes structural fetch, verification, traversal, cache, coalescing, and
authenticated zero counters; it is not a runtime performance measurement.

Every loader result is copied before validation or caching. A referenced block
that is absent, corrupt, the wrong type or level, outside logical EOF, or the
wrong leaf length fails with `EIO`. Concurrent reads coalesce the same source
fetch without allowing one caller's abort to cancel other waiters. The final
waiter's abort cancels that fetch, and `close()` promptly cancels every pending
read and prevents late source results from entering either cache.

## Implemented immutable patch builder

`MerklePatchBuilderV1` is the opt-in third foundation slice. One builder binds
one immutable base descriptor to abstract block source and idempotent sink
interfaces, admits exactly one build, and returns a new descriptor only after
all newly referenced blocks have been accepted child-first by the sink. It
does not publish a file version or establish local or remote durability. A
failed call can therefore leave unreachable content-addressed blocks for a
future generation's normal orphan collector, but it cannot expose a partial
root through this API. Source and sink must be adapters for one logical block
domain, and the sink must retain reused base references; the builder neither
copies nor revalidates untouched subtrees.

Input patches must be strictly ascending and non-overlapping. Patch count,
copied patch bytes, distinct changed leaves, verified-tree cache entries, and
verified-tree cache bytes all have configurable defaults and non-configurable
absolute ceilings. Partial leaves load and self-verify at most their exact base
leaf; full-leaf overwrites avoid that read. Existing tree paths are copied and
verified only where resolution or rewriting consumes them. Untouched child
hashes and complete truncated-away subtrees are not fetched.

The builder pads growth with authenticated sparse zeros, extends an old short
final leaf when necessary, trims a new short final leaf, collapses zero-only
ancestors, and changes the canonical root height without materializing the
whole file. A full overwrite whose hash already matches the base is still sent
to the sink, allowing the caller-provided bytes to repair a missing payload
instead of silently assuming its availability. Consumed missing/corrupt
blocks, wrong levels or lengths, adapter failures, and mutation of a submitted
block observable when `put` settles fail with `EIO`. Successful retention of
the accepted bytes remains the sink's contract; this helper cannot audit the
sink after fulfillment. Caller cancellation and `close()` promptly detach from
an adapter that ignores abort; late completion cannot produce a root. The
one-shot cache and dedup tables are released on every terminal path.

`stats()` and the result snapshot expose structural work: verified source
blocks and bytes, cache behavior, changed/reused leaf hashes, created/written
data and tree blocks, pruned references, collapsed paths, and duplicate sink
puts avoided. A nonzero changed leaf is hashed once while constructing its
canonical block and once after the sink accepts it; a partial overwrite also
authenticates the old leaf. `dataBlocksCreated` includes nonzero candidates
whose unchanged hash avoids a sink put. The differential suite checks patch, growth, shrink, sparse
collapse, root-height transitions, corruption, adapter failures, and work that
scales with distinct changed paths. These counters make no claim about a
future Peerbit transaction, receipt, GC, or mounted-write latency.

Both standalone utilities are deliberately detached from the current v9
`Documents` store, filesystem address, mount, root lease, GC, repair, and write
path. Supplying a source or sink does not establish authorization,
availability, or durability. Those remain requirements for the future
generation-specific integration.

## Patch publication

Expose a full-replica-only exact tree session. It owns an immutable base root,
a version/root lease, bounded verified node/data caches, logical size, and a
sparse dirty-range overlay. It must not allocate a whole-file buffer.

```ts
session.read(offset, length);
session.commitPatch({
    expectedNodeId,
    baseVersionIds,
    noOpIfHeadVersionIds,
    finalSize,
    ranges,
    durability,
});
session.close();
```

The portable mount keeps its existing shared per-file open state and mutation
generation fences. Reads overlay dirty ranges on the immutable base. Truncate
drops dirty data beyond EOF; growth creates holes. Append allocation remains
serialized. `fsync` captures a generation cutoff and commits only mutations
through that cutoff; later sibling writes remain dirty.

Commit order is mandatory:

1. Copy, validate, sort, and coalesce caller ranges before the first await.
2. Lease the exact content base and every causal/observed-head version.
3. Check the path and expected node.
4. Fetch only affected root-to-leaf paths and leaves.
5. Build changed leaves and path-copied nodes bottom-up.
6. Put generated data and tree blocks, dependencies first.
7. Recheck the namespace guard.
8. Publish the new immutable version last.
9. Recheck every newly introduced block and the version locally; repair if
   missing.
10. Recheck the namespace guard and advance the session to the new root.

A crash before step 8 leaves only unreachable blocks. A visible version never
precedes its newly introduced blocks. Reused sibling subtrees inherit the
leased base root's availability; normal commits must not rescan the whole base.
An explicit full-scrub mode may do so.

A no-op is valid only when the resulting `(size, leafSize, rootLevel,
rootHash)` and the complete observed head set still match. A moved content
head produces the current conflict behavior rather than a silent rebase.

## Conflict and version semantics

Retain the existing per-node causal DAG and deterministic head order. Two
peers patching the same base produce two heads even when their dirty pages do
not overlap. Explicit conflict resolution publishes a constant-size version
that points to the selected root and parents every observed head.

An optional future three-way merge may compare authenticated trees to find
disjoint changes, but automatic block-level merging is out of scope for this
generation.

## GC, Guard D, and leases

Exact read/write sessions lease versions and roots rather than enumerating all
descendants. GC adds leased versions to the retained root set.

For each run, GC must:

1. Compute retained versions using the current head, conflict, deletion,
   history, grace, pin, and lease rules.
2. Walk forward from every retained root with bounded concurrency, verifying
   hashes, types, levels, lengths, and the final content commitment.
3. Memoize shared subtrees across roots.
4. If any retained root is incomplete or corrupt, disable the entire block
   sweep for that run. An unknown descendant set cannot be deleted safely.
5. Retire metadata, settle, and rebuild/revalidate the mark set.
6. Record unmarked blocks in the existing two-run, arrival-aged orphan
   ledger.
7. On a later run, recheck reachability and the exact current log head before
   deleting tree blocks top-down and then data blocks.

Content additions/removals and authorization changes increment the existing
disposal/maintenance generation so a moving plan aborts.

Guard D must queue block-removal bursts and evaluate the union of present rows
and removed values. It climbs derived reverse edges until it reaches a
retained/leased version. If rows are missing, a lookup fails, fan-in exceeds a
bound, or the answer is ambiguous, it re-publishes all structurally valid
removed blocks in the batch. The safe failure is retained garbage, never lost
content.

Lifecycle close first stops session admission, then drains in-flight
operations and releases root leases. GC and disposal join the same generation
fences.

## Snapshot and bootstrap

Bump the snapshot format and store-domain binding. Snapshot segments continue
to contain naming heads and full version-head documents, not content blocks.
A joiner can make the tree readable from the overlay, then fetch and verify
Merkle blocks lazily by id. Unknown, missing, corrupt, or wrong-level blocks
fail with `EIO`; only an authenticated absent child is a zero range.

Overlay retirement, write readiness, and Guard D arming retain their current
fail-closed sequencing. A partial replica cannot open a lease-backed writable
tree session.

## Persisted disposal

Disposal captures a stable closure containing:

- every naming head, including tombstones and conflicts;
- every content head;
- every unique tree and data block reachable from those heads; and
- every surviving trust-log entry.

Resolve and verify each block while recording its exact resident log hash.
Pass the exact planned entries to persisted-receipt readiness, then deliver in
bounded batches: data blocks, tree blocks bottom-up, versions, naming, and
trust. A missing block, corrupt root, unsupported store, receipt failure, or
content/auth generation change fails closed and leaves the source required.

Traversal and receipt batching must be streaming and memory-bounded. The
result should report separate data/tree/version/naming/trust counts.

## Durability boundary and upstream prerequisite

The new format makes local work, hashing, storage growth, and delta replication
O(changed blocks x tree depth). Current persisted receipts prove exact entries,
not continuing custody of an unchanged subtree.

Consequently:

- a receipt over only newly introduced blocks and the new version is
  `delta-only` coverage;
- a fresh `minAcks` proof for the complete version requires traversing and
  re-acking the full reachable closure; and
- disposal remains O(total live closure), which is acceptable.

Do not label delta-only delivery as complete file durability. Strict O(delta)
full-version remote durability needs an upstream persisted-root session: a
leader verifies and retains an authenticated root closure, then accepts a
successor root plus changed blocks and atomically advances that retained-root
lease. The existing per-entry API cannot safely synthesize this guarantee.

Until that exists, expose durability coverage explicitly, for example
`"delta-only"` versus `"full-version"`; the latter is intentionally O(file).
This proposal also does not invent a hardware-cache barrier for a local mount;
`fsync` must advertise only the local-store and/or remote persisted guarantee
that the selected Peerbit backend can actually prove.

## Migration and cutover

Migration is an explicit freeze-and-copy operation, never a rolling mixed-log
upgrade:

1. Quiesce v9 writers and mounts and capture a stable source closure.
2. Create a fresh v10 filesystem and trust domain.
3. Copy every current naming head and content head.
4. Stream each legacy version's verified chunks into the Merkle builder
   without whole-file materialization.
5. Preserve node ids, naming/version ids, parent ids, and stored causal depths.
   Absent historical parents are already supported by current DAG rules;
   preserving ids and depths retains current conflict sets and visible-head
   ordering.
6. Publish blocks, converted versions, then naming.
7. Re-establish writer authorization in the destination. Do not blindly replay
   owner-authorized trust edges into a new trust domain.
8. From a fresh destination peer, compare paths, head ids, conflicts,
   tombstones, sizes, source whole-file SHA-256, and reconstructed bytes.
9. Persisted-fence the destination, distribute the new address, and retain the
   legacy filesystem read-only until cutover is accepted.

Recheck the source closure after copying and abort if it moved. Do not dual
write the two addresses: partial failure would create independent causal
histories.

## Complexity contract

For file size `F`, leaf size `B`, changed leaves `q`, and depth `d <= 6`:

| Operation              | Required complexity                                          |
| ---------------------- | ------------------------------------------------------------ |
| Patch commit           | `O(q * B + q * d)`                                           |
| New documents          | at most `q` data blocks, unique dirty ancestors, one version |
| Version metadata       | `O(causal parents)`, independent of `F`                      |
| Range read             | `O(returned leaves + d)`                                     |
| Suffix truncate        | `O(B + 256 * d)`                                             |
| Sparse growth          | `O(d)` or better                                             |
| GC/disposal/full scrub | `O(distinct reachable blocks)`                               |

A 4 KiB overwrite remains block-granular. With 64 KiB leaves it may write one
64 KiB data block plus up to six tree blocks; the target is O(delta blocks),
not byte-for-byte write amplification.

## Release-blocking gates

### Structural work counters

- Patch commits report zero whole-file hash bytes.
- Base data fetched is no more than one leaf per changed leaf, plus a final
  truncate boundary leaf.
- New data blocks do not exceed changed non-zero leaves.
- New tree blocks do not exceed unique dirty ancestor paths.
- Encoded version size is flat from 16 MiB through 1 GiB files.
- Peak memory is bounded by dirty ranges and configured caches, not file size.

### Correctness and failure injection

- Cross-runtime golden hash/encoding vectors.
- Randomized write, append, truncate, sparse-growth, reopen, and range-read
  testing against a byte-buffer oracle.
- Crash injection after every block/version publication boundary; no partial
  version may become visible.
- Concurrent writers converge to identical head/conflict sets.
- Every leaf, node, root, level, length, and missing-block corruption case
  fails closed rather than returning invented zeros.
- GC/CUT races with read and write sessions never remove reachable blocks;
  true orphans eventually disappear after the two-run barrier.
- Snapshot/bootstrap lazy reads and pending-drain behavior remain correct.
- Store-domain replay and revoked-writer puts are rejected.
- Migration preserves bytes, ids, winners, conflicts, and tombstones.
- Persisted disposal succeeds on Ubuntu, macOS, and Windows without retry or
  timeout inflation; after killing the source, recipients reopen and verify
  every head and conflict.

### Comparative performance

Use the same machine, exact lockfile, sequential ten-run p50/p95 reporting:

- A 64 MiB file's mounted 4 KiB overwrite plus local commit should be at least
  5x faster than the phase-1 flat patch path.
- A 1 GiB/4 KiB patch p95 should be no more than 2x the 64 MiB result.
- Random 4 KiB read amplification must not exceed the selected leaf size.
- Sequential 8 MiB reads and 1 MiB writes must remain within 1.25x of the
  current 512 KiB layout before the candidate becomes the default.
- Creating, stating, and reopening 1-4 KiB files must remain within 1.15x.
- The sequential 500-file cold-open profile must remain within 1.10x and add
  no slow-mode tail.

Structural counters are the primary acceptance gate; timing alone cannot prove
the complexity change.

The report-only [Merkle algorithm harness](MERKLE_BENCHMARK.md) exercises the
standalone builder and reader with bounded Map or buffered-disk block stores.
Its raw samples and exact output checks are inputs to this promotion campaign;
they do not satisfy the mounted/runtime comparison gates above.

## Suggested implementation slices

1. Golden-vector codecs, self-certifying blocks, and root verification
   (implemented, generation-isolated).
2. Read-only exact tree session and bounded caches (standalone implementation
   complete; store, lease, and lifecycle integration pending).
3. Immutable path-copy patch/truncate builder with work counters (standalone
   foundation complete; version publication and crash-boundary integration
   pending).
4. Sparse mount overlay and generation-bounded `fsync`/release integration.
5. Mark/reverse-edge Guard D and two-run tree/data GC.
6. Snapshot/bootstrap and persisted-disposal closure traversal.
7. Freeze-and-copy v9 migration and fresh-peer verifier.
8. Three-platform correctness matrix and comparative promotion benchmark.

The first implementation should stay opt-in until every structural and safety
gate passes. Layout-default selection and any claim of complete O(delta)
remote durability are separate decisions.
