# @peerbit/shared-fs-cli

## 0.13.15

### Patch Changes

- e987ba9: Bound native-mount JSONL request and response frames, process each adapter
  connection serially with write backpressure, and isolate malformed clients.
  The CLI patch publishes matching rebuilt native adapter binaries.
- c73663e: Make baseline benchmark runs use reproducible unique byte corpora, measure only
  filesystem I/O with high-resolution timers, and clean up only owned benchmark
  paths.
- 3d4f389: Lazily load the Shared FS runtime so CLI help, parser errors, and native adapter
  installation avoid initializing the full Peerbit stack.
- 69f62f9: Ship a self-contained Apache-2.0 license with both Shared FS packages. Exclude
  the CLI's internal cross-OS CI driver from its tarball and accurately declare
  the executable modules that have import-time side effects.
- Updated dependencies [2672fa4]
- Updated dependencies [e987ba9]
- Updated dependencies [c73663e]
- Updated dependencies [69f62f9]
    - @peerbit/shared-fs@0.13.14

## 0.13.14

### Patch Changes

- 263f30e: Add an exact-conflict-fenced directory merge repair that reparents observed
  direct children without changing node identities, preserves destination child
  collisions, and exposes the action and structured result through the CLI.
- Updated dependencies [263f30e]
    - @peerbit/shared-fs@0.13.13

## 0.13.13

### Patch Changes

- Updated dependencies [4f63d3a]
    - @peerbit/shared-fs@0.13.12

## 0.13.12

### Patch Changes

- f4f3b6d: Make unsupported native chmod, chown, and timestamp mutations fail closed, and
  report the synthetic metadata and access-check contract through CLI status.

## 0.13.11

### Patch Changes

- Updated dependencies [4e6e4e2]
    - @peerbit/shared-fs@0.13.11

## 0.13.10

### Patch Changes

- Updated dependencies [509b0ed]
    - @peerbit/shared-fs@0.13.10

## 0.13.9

### Patch Changes

- 9cb4d97: Add operator-grade conflict inspection and resolution commands. The CLI now
  lists content and naming conflicts in stable JSON, resolves selected content
  heads and explicit namespace actions from full write-ready replicas, and
  optionally reports both conflict classes through machine-readable status
  output. Naming resolution adds an observed-topology fence, and repeated delete
  actions now acknowledge newly visible delete-vs-edit content heads instead of
  quiescing too early. Naming actions revalidate the complete observed conflict
  topology, while status and listing JSON distinguish verified snapshot coverage
  from off, observer, plain-join, and changing partial views. Guarded delete and
  restore actions no longer absorb content heads that arrive after their final
  validated snapshot.
- Updated dependencies [9cb4d97]
    - @peerbit/shared-fs@0.13.9

## 0.13.8

### Patch Changes

- 102b5fa: Serialize filesystem lifecycle transitions and drain admitted write, disposal,
  snapshot, and garbage-collection critical tails before storage closes. Persist
  snapshot segment ownership through a locked, atomic, fsynced ledger and recover
  or fail closed when reclamation races concurrent document updates.
- Updated dependencies [102b5fa]
    - @peerbit/shared-fs@0.13.8

## 0.13.7

### Patch Changes

- e6616a8: Add an exact node-guarded remove/rename capability for native mounts, including
  typed compare-and-set mismatches, atomic replacement event publication,
  artifact-ignore forwarding, active descendant binding, and detached open-file
  handling after unlink or replacement.
- 83325b3: Share one backend-local open-file state across descriptors for the same file identity. Sibling reads now observe buffered writes and truncation immediately, backend-local appends allocate from one logical length, provisional creates share one expected-absent commit chain, and overlapping flushes coalesce without manufacturing local conflict heads. `fsync` and `release` use bounded generation cutoffs so later sibling writes cannot starve a fence, verified read snapshots are loaded once per live state, and the state is discarded after its last descriptor closes. Typed existing-node mismatches quarantine stale state across later path repair, while zero-byte writes no longer extend or dirty files.
- Updated dependencies [e6616a8]
- Updated dependencies [83325b3]
    - @peerbit/shared-fs@0.13.7

## 0.13.6

### Patch Changes

- 3f84891: Correct shared mount-backend flag handling and the external cgofuse adapter on Linux, macOS, and WinFsp: enforce descriptor access, require explicit creation, bind nested creates to the exact parent directory node, honor append and exclusive flags, materialize read-only creates, reject read-only truncation, forward cgofuse callback flags, preserve existing files during Mknod and the conservative fuse-native create shim, atomically identify expected-node and create-parent fence losses, serialize overlapping local creates and namespace transitions, and prevent buffered creates from resurrecting paths across mkdir, remove, or either side of rename. Failed one-shot Mknod releases now discard their unreachable local reservation while normal handles retain retryable buffered data. The fuse-native create callback does not expose the caller's flags and retains the documented conservative limitation; WinFsp translates Windows create semantics before the cgofuse callback.
- Updated dependencies [3f84891]
    - @peerbit/shared-fs@0.13.6

## 0.13.5

### Patch Changes

- 56df5fc: Reuse SharedFileSystem's target-verified exact-version snapshot when opening an existing file for native-mount writes, removing the mount's duplicate whole-file SHA-256 pass without changing chunk or whole-file verification. Custom mount targets retain the legacy local-hash fallback unless they explicitly implement the versioned verified-read capability.
- Updated dependencies [56df5fc]
    - @peerbit/shared-fs@0.13.5

## 0.13.4

### Patch Changes

- 08653c2: Delegate native-mount commit hashing and exact-head no-op checks to capable SharedFS targets, avoiding one redundant full-file SHA-256 pass on version-creating commits while preserving legacy target behavior.
- Updated dependencies [08653c2]
    - @peerbit/shared-fs@0.13.4

## 0.13.3

### Patch Changes

- 62104e4: Reduce large mount-write peak memory by transferring exact-sized immutable commit buffers to trusted targets and detaching on later handle mutation, while preserving isolated copies for custom targets by default.
- Updated dependencies [62104e4]
    - @peerbit/shared-fs@0.13.3

## 0.13.2

### Patch Changes

- cd4bc22: Reuse one serialized IPC connection for each external native mount session, reconnect only after surfacing a transport failure, make mount startup and IPC-server shutdown terminate retained resources, and add portable transport benchmarks across metadata and 4 KiB through 1 MiB payloads.
- 92cb810: Return isolated byte snapshots from mount reads and remove redundant buffer copies from native IPC encoding and decoding.
- Updated dependencies [cd4bc22]
- Updated dependencies [92cb810]
    - @peerbit/shared-fs@0.13.2

## 0.13.1

### Patch Changes

- e8762e4: Fence mounted `fsync` and `release` across concurrent buffered writes so every
  buffer mutation accepted before the fence is included in a published stable
  generation, and late writes to a closing handle fail instead of disappearing.
  Add a portable forced-process-termination campaign that reopens a disk-backed
  `fsync` result and both remote custodians after a persisted `minAcks: 2`
  disposal barrier, while documenting that process recovery is not a universal
  host power-loss guarantee.
- Updated dependencies [e8762e4]
    - @peerbit/shared-fs@0.13.1

## 0.13.0

### Minor Changes

- 5967703: Fail closed on fresh-join writes until a full replica has a settled initial
  view, expose retryable write-readiness APIs and EAGAIN across mount adapters,
  and make writable mount commits use the exact visible version with a path/node
  compare-and-set so replacement races cannot overwrite the new file. Add an
  audited one-time legacy-replica trust workflow; keep partial-write recovery
  session-only and block it from snapshots, GC, ACL changes, and disposal.
  Persist readiness transitions with crash-safe, synchronized fail-closed
  sidecar updates and recognize same-log replicators reached through relays, not
  only direct neighbors.

    Fence live trusted-writer grants and revocation tombstones alongside filesystem
    content during durable machine disposal, and cancel/join cold-bootstrap work so
    close and same-instance reopen cannot leak late state changes.

### Patch Changes

- Updated dependencies [cf0d415]
- Updated dependencies [63b553f]
- Updated dependencies [5967703]
    - @peerbit/shared-fs@0.13.0

## 0.12.0

### Minor Changes

- c6b102d: Add persisted per-entry machine-disposal barriers and the
  `peerbit-fs prepare-disposal` workflow, with explicit safe-disposal reporting
  and receipt-scope caveats.

### Patch Changes

- Updated dependencies [c6b102d]
    - @peerbit/shared-fs@0.12.0

## 0.11.0

### Minor Changes

- ef25101: Unattended resource lifecycle: scheduled GC, naming-compaction unstarving, and snapshot segment reclamation.
    - Scheduled garbage collection on full replicas (default every 6 h, jittered,
      first runs spread so fleets never herd; disable with `gc: false`). The
      executing half of the two-run chunk/purge barrier chains automatically once
      candidates mature, anchored to the recording run's start so it can never
      fire early. Gates: bootstrap phase, peer evidence on unverified replicas,
      the manual-run mutex, and a courtesy deferral while a snapshot publishes.
      Failures back off exponentially and surface as gc:error events; successes
      as gc:run. New gcStatus() accessor; scheduled run options are allowlisted
      (dryRun, nowMs, and immediate chunk sweeps are stripped with a warning).
    - Naming compaction no longer starves under active heads: the gate is now
      per-head arrival stability (visible locally for namingHeadStabilityMs,
      default 1 h, backdate-proof) instead of every-head author age; retired
      events still stay past namingGraceMs by both stamps. A per-node batch cap
      (namingCompactionBatchLimit, default 500, shallowest-first with the
      fixpoint re-run) bounds upgrade-day delete bursts. The resurrection guard
      gains a split-flush damper so reordered mid-chain deletes from a
      compaction burst cannot plant permanent spurious heads, while genuinely
      lagging peers keep full resurrection protection.
    - Superseded snapshot segment blocks are reclaimed after a grace period
      (snapshot.segmentReclaim, default 3 h, floored at the bootstrap staleness
      cap). Only positively recorded own segments are ever deleted, re-verified
      at deletion time against every locally known live manifest, with a
      generation-CAS side-state ledger so CLI and daemon writers never lose
      records and publish intent recorded before any throw-capable step.
      GcReport gains segmentBlocksDeleted and reclaimedSegmentBytes; the CLI gc
      report prints them and status/mount show the schedule state.
    - Fixes a pre-existing indexing bug: replicated bootstrap manifests indexed
      with an undefined kind (class initializers are bypassed on
      deserialization), leaving other authors' manifests invisible to kind
      queries on non-author replicas.

### Patch Changes

- Updated dependencies [ef25101]
    - @peerbit/shared-fs@0.11.0

## 0.10.0

### Minor Changes

- 32a42ec: Writer revocation: `revokeWriter(publicKey)` on the handle and `peerbit-fs revoke <address> <public-key>` remove the caller's outgoing trust edge, so de-provisioned machines lose write access as each replica's trust-graph copy converges. Built on trusted-network 6.0.101's owner-authorized revocation, which also closes the admin-grade delete hole (a trusted member can no longer remove trust edges it does not own). Revocation is not retroactive: pre-revocation documents remain, and a writer trusted through another live path stays trusted until every path is revoked (the CLI warns when that is the case).

    Also upgrades the engine cohort to peerbit 5.3.34 / document 15.0.15 / shared-log 16.0.14, and re-measures the crash-then-join scenario: upstream's stale-provider rotation removes the old total-unavailability failure even without our connected-peers fetch routing, but 1 in 4 unrestricted joins still hit an ~80s delivery-timeout tail, so the routing restriction stays (consistent ~0.2-2s joins).

### Patch Changes

- Updated dependencies [32a42ec]
    - @peerbit/shared-fs@0.10.0

## 0.9.0

### Minor Changes

- d3afda2: Write-set barriers: `writeBatch(entries, { manifest: true })` publishes an inner-signed changeset manifest recording the batch's exact membership, committed after every member so a crashed prefix never certifies. Any replica gates on the turn with `awaitChangeset` — resolving when every member document has been admitted locally. Store salt v8 -> v9 (new document kind): recreate filesystems and upgrade all peers together.
    - Honest verdicts: historic turns whose members were garbage-collected resolve "collected-or-incomplete"; unknown ids time out (default 30s) with the full status attached to the error.
    - `changesetStatus()` snapshots the same view; `watchChangesets()` streams manifest arrivals and once-per-transition completions, queued during a bootstrap overlay so a triggered read always sees the whole turn.
    - Manifest-scoped barriers are unforgeable: member ids are unguessable 32-byte identities bound under the manifest's inner signature, so no other writer can satisfy or extend the barrier.
    - Same-changesetId retries after a crash are safe: no-op entries adopt the young documents that already satisfy them (48h adoption horizon, the GC grace floor), and applied edits and deletes adopt their young naming context.
    - Hostile manifests are bounded at ingest (payload/member caps, store binding, authenticated author mirrors, 1h future-clock skew); manifests retire by local arrival age in `collectGarbage` (`GcReport.manifestsRetired`).

### Patch Changes

- Updated dependencies [d3afda2]
    - @peerbit/shared-fs@0.9.0

## 0.8.0

### Minor Changes

- b09682c: Change notification: `fs.watch(path?, options?)` subscribes to
  filesystem-shaped events for a path or subtree, replacing polling as the way
  embedders observe a live multi-party filesystem.
    - Events are transitions of the view the read API serves: `created`,
      `modified`, `deleted`, `renamed` with `path`/`oldPath`, `nodeId`,
      `parentId`, `kind`, the visible `versionId`/`contentHash`, write-set
      attribution (`changesetId`, `author`, `origin: "local"|"remote"`), and a
      `cause` tag (`data`, `policy`, `overlay-timeout`, `snapshot`).
    - Delivery is batch-shaped: one settle window (`settleMs`, default 20 ms;
      `0` = microtask latency with `maxSettleMs` as the liveness cap) coalesces
      churn, so a whole `writeBatch` typically arrives as one batch with per-node
      net transitions. Applying a batch in order to a path-keyed mirror
      reproduces recursive `list()`; a directory `deleted`/`renamed` carries its
      subtree (descendants get no individual events).
    - The watcher maintains a per-subscription materialized view diffed through
      the same winner pipeline as `list()`/`stat()` (extracted as
      `listByParentId`/`resolvePathDetailed`), so late-arriving causal history
      that flips a winner surfaces as the correct rename/modify/delete — and
      garbage collection, history retirement, and resurrection-guard re-puts
      emit nothing. Removal-caused losses are quarantined until the guard
      settles (`guardHoldMs`) before an honest `deleted` is emitted.
    - Cold-start aware: a watcher attached before or during a snapshot-overlay
      bootstrap re-snapshots at overlay activation (`cause: "snapshot"`) and
      reports an unverified-timeout view shrink as `cause: "overlay-timeout"`.
    - Ignore-aware handles filter the stream through their own policy; a rules
      change reconciles the emitted stream with `cause: "policy"` events;
      `includeIgnored: true` bypasses. `initial: "snapshot"` delivers the
      existing tree as a first batch; `maxNodes` bounds the view (typed
      `EWATCHLIMIT` error); `AbortSignal` and async iteration are supported,
      and slow consumers get composed batches (bounded memory, never a stale
      mirror). `SharedFsHandle.close()` closes that handle's watchers only.

    No store schema change and no salt bump: peers with and without the watch
    layer interoperate freely; the hot-path cost with no watchers is one null
    check per change burst.

### Patch Changes

- 69915dd: Upgrade the Peerbit cohort to peerbit 5.3.33 / @peerbit/document 15.0.13
  (shared-log 16.0.13 with batch signature verification under application
  authorization, indexer-sqlite3 3.0.18 with ordered write sessions, program
  6.0.54, trusted-network 6.0.99) and rebaseline the multi-party workload.

    Measured on the 2,000-file / ~6,200-document cold join (three instrumented
    runs per cohort, identical instrumentation): complete convergence median
    12.7s → 9.6s (~25% faster) with ~24% less joiner CPU and 1.9x faster SQLite
    insert statement time; receive-batch shape (13 batches, p50 ~84 docs) and
    message counts unchanged, so the gain is genuinely per-entry ingest cost —
    consistent with upstream's 21.5% elapsed improvement claim. The 500-file
    live-join case (ten counterbalanced runs per cohort) is unchanged within
    noise and revealed a pre-existing bimodal structure on BOTH cohorts (~0.8s
    fast path vs 3-4.5s slow path) now reported upstream.

    No shared-fs code change; full suite green. The install recipe matters:
    pin the whole cohort (including program/trusted-network) before installing,
    never run `pnpm dedupe` (it evicts the subtree peerbit copy and splits the
    class registries — replication silently drops every document).

- Updated dependencies [69915dd]
- Updated dependencies [b09682c]
- Updated dependencies [1d7fdbc]
    - @peerbit/shared-fs@0.8.0

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

- Updated dependencies [ea3279a]
    - @peerbit/shared-fs@0.7.1

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

### Patch Changes

- Updated dependencies [56edf8d]
    - @peerbit/shared-fs@0.7.0

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

- Updated dependencies [8b65660]
- Updated dependencies [32c6681]
- Updated dependencies [1a35ea3]
    - @peerbit/shared-fs@0.6.0

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

### Patch Changes

- Updated dependencies [30776f7]
    - @peerbit/shared-fs@0.5.0

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

### Patch Changes

- Updated dependencies [4033782]
- Updated dependencies [0682058]
    - @peerbit/shared-fs@0.4.0

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
