# Merkle storage v1 codecs

Status: the block codecs, the file-version codec, the golden vectors, the
validators and an isolated read-only range session are implemented. The v10
fields of the file version (marked below) land in M1 of
[MERKLE_V10_GENERATION.md](MERKLE_V10_GENERATION.md), which makes these codecs
the only storage format of shared-fs in one breaking release, with no
migration. This document is normative for the codecs, hash domains, golden
vectors, validation and read session only; the write path, GC, snapshots,
disposal, gates and complexity contract live in that document.

## Canonical content model

All hashes below are SHA-256 over canonical Borsh-encoded fields with the
literal domain prefix shown. Hashes are stored as 32-byte values internally and
rendered as unpadded base64url in document ids. Domain prefixes are literal
UTF-8 bytes without a length prefix. An optional root hash is encoded as one
`u8` presence byte (`0` or `1`), followed by the fixed 32-byte hash only when
present.

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

- There is one leaf size, fixed by MERKLE_V10_GENERATION.md section 2.5. The
  codec currently also accepts 64 and 256 KiB; v10 narrows it to the one size,
  so there is no rechunk operation.
- A non-final present leaf is exactly `leafSize` bytes. The final leaf may be
  shorter.
- An all-zero leaf is omitted. An absent child in an authenticated tree means
  zeros; a missing referenced block never means zeros.
- A one-leaf file points directly to its data block, avoiding a tree document.
- Block bytes are copied before hashing or caching and are verified again on
  every untrusted fetch.

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
Slot `i` is bit `(i & 7)` of byte `(i >>> 3)`, least-significant bit first. The
hash preimage uses Borsh little-endian integers: the child vector carries its
`u32` element count, while each fixed 32-byte hash carries no length. Level 1
points to data blocks; a level-N tree points only to level-(N-1) tree blocks.
Empty nodes, duplicate slots, non-canonical ordering, and unknown levels are
invalid. Six levels cover the u64 file-size domain at the minimum leaf size.

Page indices are decomposed into big-endian base-256 digits. Path copying
rewrites only ancestors of changed leaves. Empty ancestors collapse. Suffix
truncation removes complete subtrees and rewrites only the boundary path.

### File versions and signed roots

```text
MerkleFileVersionV1 {
    id: string
    storeBinding: [u8; 32]      // v10
    nodeId: string
    parentVersionIds: string[]
    causalDepth: u64
    size: u64
    mode: u32                   // v10, v9.1 semantics
    mtime: u64                  // v10, v9.1 semantics
    leafSize: u32
    rootLevel: u8
    rootHash?: Hash32
    contentRoot: Hash32
    createdAt: u64
    authorKey: string
    machineLabel: string
    conflictResolution: bool
    changesetId?: string
}
```

The implemented class lacks the three v10 fields and still ends with an
optional `legacyWholeSha256`, which v10 drops. `storeBinding` is SHA-256 of
the canonical program bytes; `mode` and `mtime` follow v9.1
(MERKLE_V10_GENERATION.md section 2.3).

`rootLevel` is the minimum level capable of addressing `size`; level 0 means a
direct data root. `rootHash` may be absent only to describe an entirely
zero-filled file. Size remains authoritative for the final leaf and visible EOF.

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

`contentRoot` is the authoritative content identity. A conventional whole-file
SHA-256 is inherently O(file), so a patch commit never computes one.

The complete root descriptor is covered by the trusted Peerbit log-entry
signature. Bootstrap segments are covered by their trusted manifest signature.
Keep `authorKey` advisory: requiring equality with every outer signer would
prevent a trusted replica from re-publishing an immutable version during
recovery.

### Index projection

The index row carries a derived `blockRefs` vector:

- a version row references zero or one root;
- a tree row references at most 256 children;
- a data row references none.

`blockRefs` is derived from a structurally validated value
(`merkleRootBlockRefsV1`, `merkleTreeBlockRefsV1`), never trusted as an
independent author-supplied mirror. It removes the approximately 8,000-chunk
version ceiling and provides reverse edges for Guard D.

Data and tree blocks live in the entries `Documents` collection, which keeps
trusted admission, replication, persisted-entry delivery and recoverable CUT
behavior. Direct raw-block storage is a later optimization, only once it can
provide equivalent authorization, replication, receipt and reclamation
semantics.

## Validation and authorization

Untrusted content bytes enter only through `decodeMerkleContentEntryV1()`, with
exact variant preflight and canonical reserialization. Documents ingest applies
the same rules in `canPerformEntry` (MERKLE_V10_GENERATION.md section 2.2).

Ingest validation must be structural and independent of local replication
order:

- reject unknown entry kinds by default;
- enforce id/hash equality, block-size bounds, bitmap/popcount equality,
  canonical child ordering, non-empty tree nodes, allowed layouts, canonical
  root level, version-parent bounds, and changeset bounds;
- do not require referenced children or parents to be locally present;
- enforce exact level-N to level-(N-1) tree transitions during traversal;
- bind file versions, naming events, and snapshot and changeset payloads to
  the store.

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
- No remote full-version durability is claimed: persisted receipts prove exact
  entries, not continuing custody of an unchanged subtree.

## Read session

`MerkleReadSessionV1` accepts a copied root descriptor and an abstract
asynchronous source of decoded data and tree blocks.
`read(offset, length, { signal })` walks only the intersecting authenticated
tree paths, clips at the signed logical EOF, and returns absent authenticated
children as zeros. The single-read allocation, verified tree LRU, and verified
data LRU all have explicit bounds. The configurable 64 MiB single-read default
is also subject to a fixed 256 MiB ceiling. `stats()` exposes structural fetch,
verification, traversal, cache, coalescing, and authenticated zero counters; it
is not a runtime performance measurement.

Every loader result is copied before validation or caching. A referenced block
that is absent, corrupt, the wrong type or level, outside logical EOF, or the
wrong leaf length fails with `EIO`. Concurrent reads coalesce the same source
fetch without allowing one caller's abort to cancel other waiters. The final
waiter's abort cancels that fetch, and `close()` promptly cancels every pending
read and prevents late source results from entering either cache.

Supplying a source does not establish authorization, availability, or
durability; the block source, leases and mount integration are specified in
MERKLE_V10_GENERATION.md sections 4 and 5.
