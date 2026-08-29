# @peerbit/shared-fs

## 0.7.1

### Patch Changes

- ea3279a: Upgrade the Peerbit cohort to peerbit 5.3.32 / @peerbit/document 15.0.12
  (shared-log 16.0.12, indexer-sqlite3 3.0.17, program 6.0.53, trusted-network
  6.0.98) and rebaseline the multi-party scenarios on the new engine. No
  shared-fs code change; full suite green (89 library + 9 CLI tests).

    Measured on the standing scenarios, old cohort → new cohort, same machine:
    - Plain 2,000-file / ~6,200-document cold join: converge 5.14s → 3.48s wall,
      6.48s → 4.40s joiner CPU (~1.5x). The SQLite-batching engine win reaches
      the join at roughly one third of its microbenchmark headline: joiner-side
      INSERT statement time fell 7.33s → 2.21s (3.3x) under identical
      instrumentation, but per-entry signature verification and decode now
      dominate, so the 4.96x index-engine result does NOT translate 1:1.
    - 100-file write burst: 137ms → 113ms sequential median, 67ms → 51ms as one
      write batch.
    - 60-file remote convergence: 0.6–1.0s → 0.5–0.8s, zero timeout incidents in
      every round on both cohorts.
    - Dead-provider scenario (a fully converged replica crashes, then a cold
      peer joins via the live donor): on the old cohort the join was IMPOSSIBLE —
      the program-manifest fetch hit the 30s delivery timeout four times in a
      row (>120s, both with and without the connected-peers fetch routing, which
      never covered the Program.load path). On the new cohort the same join
      opens in 2.1s and converges in 7.4s. The connected-peers routing
      (`remote.from`) is retained: with it disabled the join still succeeds but
      takes 63s to first read, so upstream's reachable-provider prioritization
      removes the unavailability, not the whole penalty.
    - Cross-network relayed joins and live write→visible latency: unchanged
      (~11–12s and ~16ms respectively).

## 0.7.0

### Minor Changes

- 56edf8d: Artifact ignores: keep derivable, high-churn build trees out of the
  replicated store, in two tiers chosen by what can be deterministic.
    - Sealed tier (ingest): an immutable `sealedIgnoredNames` list on the
      program — part of the store address, so identical on every peer
      forever — rejects DIRECTORY basenames (default `["node_modules"]`) at
      ingest, replication-order-independent. The canonical catastrophic
      flood bounces fleet-wide before any replication, index, GC or
      snapshot cost is paid. Files with sealed names stay legal; changing
      the sealed list means a new filesystem. Names under `.peerbit-` are
      now reserved for control surfaces at ingest too.
    - Policy tier (write/view): a per-open ignore policy — gitignore-subset
      patterns (prefix-closure semantics: every rule is a subtree boundary;
      no negation by design) from open args plus the replicated
      `/.artifactignore` file, read strictly as data with validate-compile-
      swap and last-good fallback. The wrapper rejects writes into ignored
      paths (typed `EIGNORED`), refuses boundary-crossing renames
      (`EXDEV`), skips-and-reports batch entries under `onIgnored: "skip"`,
      hides (or annotates) leaked store entries in views while keeping them
      readable by exact path, and always surfaces boundary-path conflicts.
      The contract, pinned by tests: a peer's mutable policy may influence
      what it WRITES and SHOWS — never what the store ACCEPTS, RETIRES,
      RESURRECTS, or SNAPSHOTS, so divergent configs can only waste
      resources, never corrupt shared state.
    - Bootstrap window: snapshot manifests carry the publisher's effective
      patterns as signed advisory rules, installed into a joiner's matcher
      at manifest-accept time — before any content lands — until the real
      rules file is readable.
    - New surface: `ignore` and `sealedIgnoredNames` open options,
      `ignoreCheck()` / `ignoreStatus()`, `ignore:rules-changed` /
      `ignore:rules-file-degraded` / `ignore:rules-file-conflict` events,
      `ARTIFACT_IGNORE_STARTER` pattern set, `WriteBatchResult.skipped`,
      `SharedFsEntryInfo.ignoredLeak`.

    The machine-local overlay ("divert" mode), hygiene tooling for
    already-leaked trees, and mount-tier passthrough are staged follow-ups.
    Schema note: program schema extended and manifests widened; store salt
    bumped to /shared-fs/v8. Recreate filesystems and upgrade all peers
    together.

## 0.6.0

### Minor Changes

- 1a35ea3: Cold-start bootstrap: a new party opening an existing filesystem reaches a
  readable, winner-correct tree in about a second, independent of log size,
  then converges to a normal full replica in the background.
    - Trusted full replicas periodically materialize their retained HEAD
      state (all naming heads including deletes, all version heads, no
      history, no chunks) into content-addressed segments plus a signed
      manifest (`snapshotWrite()`, automatic publication on long-running
      replicas, `peerbit-fs snapshot` for one-shot use).
    - A cold joiner discovers the newest manifest, verifies the inner
      signature against its OWN trust graph, re-hashes every fetched segment
      against the signed manifest, structurally validates every document,
      and serves reads from an in-memory read-through overlay — nothing
      bootstrap-vouched ever enters the log, index, or block store. Segment
      count adapts to snapshot size and fetches route to currently connected
      peers only, so joins stay fast even when the replicator set carries
      dead ex-members; content streams lazily through the existing
      hash-verified remote chunk fetch.
    - The overlay retires per document (arrival, removal, or supersession
      proven by a causal descendant); on verified retirement the caches are
      cleared and the resurrection guard arms. Until then the guard stays
      disarmed and garbage collection is gated, and a persisted marker keeps
      both across a crashed bootstrap. Every failure falls back silently to
      a plain join (`bootstrap: { mode: "require" }` throws instead).
    - Whole-store conflict/changeset scans throw a typed
      `BootstrapPendingError` while the overlay is active (pass
      `{ allowPartial: true }` for partial-index results). New surface:
      `bootstrapStatus()`, `awaitBootstrapConverged()`, `bootstrap:ready` /
      `bootstrap:converged` events, `bootstrap` and `snapshot` open options.
    - Fixed in passing: remote chunk fetch was silently disabled on every
      peer that opened an existing address with default options (a field
      initializer bypassed by deserialization), and empty remote answers are
      now retried within the configured fetch budget instead of failing the
      read while the serving peer is saturated.

    Measured (2000 files / 4201 head documents): tree readable 1.2s after
    open with the entire log still pending, first lazy content read 1.7s,
    background convergence 6.3s — versus 3.1s to readability on a plain join,
    a gap that grows linearly with retained history.

    Schema note: new bootstrap-manifest document kind; store salt bumped to
    /shared-fs/v7. Recreate filesystems and upgrade all peers together.

### Patch Changes

- 8b65660: Fix a cache fill/event race: the per-node row caches computed a fill epoch
  but never checked it, so a cache-miss fill whose row query raced a
  concurrently arriving document could install a stale bucket that silently
  hid the superseding row (a newer version or rename) for as long as the
  bucket stayed warm. Fills now install only when the node's epoch is
  unchanged across the fill's awaits, matching the directory-sweep cache.
- 32c6681: Cold-join accelerators: roughly halve the time and CPU a new party spends
  replicating an existing filesystem.
    - Raw exchange-heads sync is enabled on the entries store: senders ship
      raw entry blocks and the receiver batch-computes content addresses and
      batch-verifies signatures (using the wasm verifier when available),
      marking entries preverified. Negotiated per connection with a
      compatible fallback; per-document validation still runs unchanged.
    - Trust verdicts are memoized: the trust-graph reachability check ran
      once per replicated document for a handful of distinct signers. Positive
      verdicts live until any trust-graph change flushes the cache (so
      revocations apply immediately); negative verdicts expire after one
      second so writers whose trust relation is still replicating are
      retried.

    Measured on the multi-party cold-join benchmark (2000 files, 6200
    documents): full convergence 6.0-7.1s before, 3.1s after, with receiver
    CPU halved.

## 0.5.0

### Minor Changes

- 30776f7: Write batches: apply a multi-file change set as one unit with a queryable
  changeset identity.
    - `writeBatch(entries, { changesetId? })` applies many writes and deletes
      together: parents are resolved once against a shared overlay (missing
      directories are created), chunk-dedup probes and chunk IO are batched
      across the whole set — measured ~40% faster than sequential writes for
      a 100-file change — and unchanged-content entries are skipped for free.
      Batches are serialized per instance, conflicting paths (one entry's
      path under another's) are rejected up front, and directory deletes
      throw EISDIR rather than silently skipping.
    - Atomicity contract: per file always — chunks land before the version
      that references them, and a new file's naming event lands last, so a
      crashed or replicated prefix never shows a partially present new file.
      Across entries the batch is not transactional: edits become visible as
      their versions land. Delete events are appended after all creates, so
      intermediate states preserve data (a delete+create rename never
      transiently shows neither file).
    - Every applied version and naming event carries the batch's `changesetId`
      (generated when omitted, bounded 1-256 chars at ingest), projected into
      the index and queryable on any peer via
      `versionsByChangeset(changesetId)` — a commit-like handle over
      multi-file changes for tracking and review flows. The identity is
      advisory attribution among trusted writers, and the record is a view
      over retained history that shrinks as GC retires superseded versions.

    Schema note: index projection widened; store salt bumped to /shared-fs/v6.
    Recreate filesystems and upgrade all peers together.

## 0.4.0

### Minor Changes

- 4033782: Garbage collection: bounded version history, naming compaction, and real
  chunk-byte reclamation — explicit-only, converging, and layered against data
  loss.
    - `SharedFsHandle.collectGarbage(options)` / `peerbit-fs gc <address>`:
      retires superseded file versions (always keeping current heads, the newest
      `keepVersions`, everything younger than retention/grace, conflict-recoverable
      versions, and in-flight reads), compacts settled per-node naming histories,
      purges fully-deleted nodes after a barrier, and deletes chunks no surviving
      version references. `--dry-run` and `--json` supported.
    - Safety stack: winner selection now reads a stored causal depth (validated at
      ingest), so compaction can never change visible winners on any peer; plans
      are pure functions of the local set with a grace-closure fixpoint (deleting
      history can never promote spurious heads); a two-run ledger barrier means a
      freshly-bootstrapped or long-offline replica records candidates and deletes
      nothing; every deletion is head-verified with automatic restore on races;
      and every full replica runs a resurrection guard that re-puts any removed
      chunk still referenced, removed content head, or removed naming head.
    - Writers close the dedup/GC race: a chunk put is skipped only when a version
      younger than the skip horizon references it, presence is re-verified after
      every save, and partial replicas always re-put (`dedup: "off"` forces
      re-puts everywhere).
    - Restoring a deleted file now carries content (a fresh version reference) and
      fails loudly with ENOENT when nothing recoverable survives, instead of
      resurrecting a contentless ghost. Deletion tombstones are kept forever, so
      purges stay sticky against stale writers.
    - Honesty note: version/naming GC reclaims index rows and hot-path CPU;
      metadata deletions each leave a small permanent log tombstone. Only chunk
      GC reclaims real bytes, and by default it lags one run (the safety barrier).

    Schema note: breaking (store salt bumped to /shared-fs/v4; stored causal
    depth and a chunk reference index were added). Recreate filesystems and
    upgrade all peers together.

- 0682058: Index-served metadata plane with per-node row caches: flat hot-path latency
  under high-churn multi-party workloads.
    - Causal references, depths, sizes, content hashes and attribution are
      projected into the document index; head selection and path resolution run
      on index rows and, for warm nodes, entirely on in-memory row caches
      maintained from change events (local writes upsert directly). Reads resolve
      exactly the winning version document.
    - Measured on the new multi-party workload benchmark: stat/read of a file
      with 300 retained versions dropped from ~6.5 ms (linear in versions) to
      ~0.3–0.6 ms (flat); listing a directory containing hot files 6.7 ms →
      0.4 ms; 2000-entry directory listing 169 ms → 80 ms; cross-peer write→
      visible latency unchanged at ~16 ms.
    - New benchmark suite (multi-party-workload.test.ts) with budgets: hot-file
      version pileup, 100-file write bursts, wide directories, write→visible
      propagation, and 500-file cold joins — medians print to CI for trend
      tracking.
    - The dedup-skip witness horizon is configurable per deployment
      (`dedupSkipHorizonMs`, floor 5 minutes; all writers should agree), and GC
      retention clamps to horizon + grace — enabling short-retention
      deployments where files are saved hundreds of times a day.

    Schema note: breaking (index projection widened; store salt bumped to
    /shared-fs/v5). Recreate filesystems and upgrade all peers together.

## 0.3.0

### Minor Changes

- 88694a3: Causal naming: placement and deletion as an append-only event DAG.

    Naming is rewritten as per-node immutable naming events with causal parent
    pointers, mirroring the content version DAG. The LWW records
    (FileRecord/DirectoryRecord/DeleteMarker) are removed; wall clocks no longer
    participate in any convergence decision.
    - Content writes never touch naming: a concurrent rename can no longer be
      silently reverted by a save.
    - Concurrent renames of one node converge to a deterministic winner on
      every peer and are surfaced as a `multi-head` naming conflict.
    - Deleting a file records the content heads the delete observed; a
      concurrent edit the delete did not observe is surfaced as
      `delete-vs-edit` with the recoverable version ids —
      `resolveNamingConflict(nodeId, { type: "restore" })` resurrects the file
      with the edit intact. Concurrent-delete data loss is now recoverable
      instead of silent.
    - Concurrent same-name creates keep one deterministic visible winner; the
      shadowed node is surfaced as `duplicate-name` and healed with `move`.
    - Unreachable nodes (deleted parents, cross-move cycles) are surfaced as
      `unreachable` and healed with `restore`/`move`.
    - New APIs: `namingConflicts(path?)` and
      `resolveNamingConflict(nodeId, action)` with quiescent no-op semantics
      (concurrent identical resolutions converge without ping-pong);
      `SharedFsEntryInfo.namingConflict` flags contested paths.
    - Writing over a deleted path creates a fresh node; restoring the old
      node surfaces a deterministic duplicate-name conflict.

    Schema note: breaking. The store derivation salt is bumped so 0.2.x and
    0.3.x peers can never attach to the same log; existing filesystems must be
    recreated (addresses change) and all peers upgraded together. Mount-level
    surfacing of naming conflicts follows in a later release.

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

- 3c6d81c: Add a five-peer convergence test suite and a scaling latency guard.

    The multi-peer suite locks in the sync invariants that previously had no CI
    coverage: multi-chunk replication to all peers (the pre-0.1.0 fragmentation
    regression), deterministic convergence of concurrent same-name file and
    directory creates, agreed outcomes for delete-vs-write and rename-vs-write
    races, cold joins of access-controlled filesystems reading full history, and
    a no-torn-reads invariant while chunks replicate.

    The scaling guard grows the store 20x and fails if per-operation medians
    (stat, read, list, write) grow more than 4x — catching any return of
    O(store)-per-operation behavior long before it reaches the old linear cost.

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

## 0.0.6

### Patch Changes

- bb5c9ac: Align Shared FS with the Peerbit 5.3.22 runtime cohort and Node.js 22 so trusted-writer keys and log entries share one package identity graph.

## 0.0.5

### Patch Changes

- c013794: Update peerbit dependencies to the native-move release (peerbit 5.3.0, @peerbit/document 13.1.0, @peerbit/shared-log 13.2.0). No code changes required — the release is API-compatible; native paths remain opt-in and off by default.

## 0.0.4

### Patch Changes

- 9b3932d: Refresh shared-fs dependencies to the Peerbit release that keeps
  `@peerbit/libp2p-test-utils` out of production installs.

## 0.0.3

### Patch Changes

- 4bae531: Document and test the lean npm install path using `--omit=peer` so Node.js CLI
  installs avoid optional browser and React Native peer packages.

## 0.0.2

### Patch Changes

- 6f2ec6e: Document the published shared filesystem install path, native adapter setup,
  platform prerequisites, and authenticated multi-machine mount flow.
