# Peerbit Shared FS

Experimental shared filesystem primitives for Peerbit.

This package is intentionally marked experimental. It provides the Peerbit-backed
metadata and content model used by the `peerbit-fs` CLI and native mount adapters.

```bash
npm install @peerbit/shared-fs
```

```ts
import { openSharedFs } from "@peerbit/shared-fs";
import { Peerbit } from "peerbit";

const peerbit = await Peerbit.create({ directory: "./peerbit-fs-state" });
const fs = await openSharedFs({
    peerbit,
    machineLabel: "workstation-a",
    rootKey: peerbit.identity.publicKey,
});

await fs.mkdir("/docs");
await fs.writeFile("/docs/hello.txt", new TextEncoder().encode("hello"));
console.log(await fs.readFile("/docs/hello.txt"));
console.log(fs.address);
```

The model is commit-on-close for mounted writes, local-first, and conflict
preserving. Concurrent versions are never overwritten silently; they are exposed
through `conflicts()` and can be resolved with `resolveConflict()`.

Naming (placement and deletion) is a per-node causal event DAG, mirroring the
content version DAG: renames and deletes append immutable events, content
writes never touch naming, and every visible choice is a pure clock-free
function of the replicated documents. Concurrent renames, delete-vs-edit
races, duplicate-name creates, and unreachable nodes are surfaced through
`namingConflicts()` and settled with `resolveNamingConflict(nodeId, action)`
(`keep` / `restore` / `delete` / `move`) — a delete that raced a concurrent
edit is recoverable, not lost.

Metadata operations (`stat`, `list`, `readFile`, path resolution) are served by
indexed queries against the local document index — cost scales with the result,
not with the total store size, and file content chunks are only loaded by
reads. Every syncing peer keeps a full replica by default
(`replicate: { factor: 1 }`); pass `replicate: false` for a peer that should
not store content — reads then fall back to bounded remote chunk fetches
(`remoteChunkFetch`), and locally authored entries are always kept.

## Write readiness on joins

Opening an existing address is readable immediately but starts write-gated
until a full replica has received unambiguous remotely committed namespace data
(or a verified snapshot), bootstrap has retired, a replicator for this specific
log is still reachable, synchronization is idle, and arrivals have stayed
quiet. Every mutating API fails early with retryable `EAGAIN` while gated. Wait
before starting a writer or service:

```ts
const fs = await openSharedFs({
    peerbit,
    address,
    machineLabel: "workstation-b",
});
await fs.awaitWriteReady({ timeout: 120_000, signal });
await fs.writeFile("/docs/hello.txt", "hello from workstation-b");
```

Newly created filesystems and previously proven warm full-replica reopens are
ready immediately. `replicate: false` handles cannot establish a complete
namespace and remain write-gated. `allowPartialWrites: true` is an explicit
unsafe, session-only recovery escape hatch: it can create duplicate paths or
base a write on stale state, and it never persists a readiness proof. The
override is limited to namespace recovery mutations; snapshot publication,
garbage collection, ACL changes, and disposal certification still require
genuine readiness. Closing and reopening without the override returns to the
write gate.

The current readiness fence is deliberately a settled-view heuristic, not a
cryptographic or protocol-level remote log frontier: Peerbit does not expose
such a frontier yet. Late arrivals restart the quiet window, but a sufficiently
long synchronization pause can still arrive after readiness. If the actual
donor disconnects, an unrelated connected Peerbit peer cannot satisfy the
fence. A fast no-snapshot join may receive its namespace while `entries.open()`
is running; that data counts only when the document change is paired with the
lower log's successful network-commit phase. Local replay has no such phase, so
a populated store whose sidecar was lost cannot certify itself merely by
reopening. If that store and its donor are already identical, it remains gated
until a later normal donor mutation or verified snapshot supplies new evidence.
A truly empty remote filesystem likewise has no namespace evidence, so a fresh
join remains closed unless it receives a verified empty snapshot or the caller
consciously uses the unsafe override. Protocol-grade empty-log and
no-late-arrival proofs require an upstream shared-log frontier/barrier API.

Access-controlled filesystems have an additional upstream limitation: write
readiness fences the namespace log, not an authoritative trusted-writer
frontier. Trust changes converge eventually, and filesystem entries carry no
authorization epoch, so a cold replica after revocation cannot distinguish the
writer's legitimate pre-revocation history from post-revocation writes. Do not
use `awaitWriteReady()` as proof that a revocation is globally enforced.
Quiesce and isolate the revoked machine/key, wait until every serving replica
reports `isTrustedWriter(key) === false`, and retain at least one already
converged durable replica before disposal. A signed trust frontier plus
entry-bound authorization epochs is required upstream to close this gap.

`peerbit-fs create` publishes a signed zero-document snapshot so the normal
empty create/mount/share flow has that evidence. Stores created before the
readiness marker was introduced are intentionally not trusted silently. Merely
connecting an already-identical donor may produce no new arrival event. The
non-assertion path is to keep a complete replicator connected and make one
normal remote namespace mutation after the legacy handle opens. Otherwise,
after independently verifying the exact local directory, make a one-time
operator assertion:

```ts
const status = fs.bootstrapStatus();
if (status.legacyPromotionEligible) {
    await fs.trustLegacyLocalReplica({
        assumeComplete: true,
        timeout: 30_000,
    });
}
```

Only use that assertion when this same directory was previously a complete full
replica, was cleanly shut down, was never copied mid-bootstrap, and its data has
been inspected. It strictly persists a per-directory/per-address marker before
enabling writes; do not copy that marker to another machine. `bootstrapStatus()`
reports `writeReadinessSource` and `legacyPromotionEligible` for audit and
diagnosis. `allowPartialWrites` is for exporting or repairing data during one
session, not for migration.

## Cold-join telemetry

Pass an opt-in callback to measure one address-open without retaining a
profiling hook in Peerbit's shared log:

```ts
const fs = await openSharedFs({
    peerbit,
    address,
    telemetry: {
        bootstrap(event) {
            console.log(event.type, event.atMs);
        },
    },
});
```

Every `BootstrapTelemetryEvent.atMs` is monotonic elapsed time since that open
started (`open:start` is zero). Stage events additionally report their own
`durationMs` and relevant counts. The stream covers document-store open,
manifest discovery, segment fetch, overlay installation and readiness,
pending-document drain, verified or unverified overlay retirement,
synchronizer idle, write readiness, fallback, and abort. A callback exception
or rejected return is ignored so observability cannot change filesystem
behavior. Callbacks run inline and returned promises are not awaited, so keep
the handler lightweight and hand events to an external queue for slower work.
When no callback is supplied, Shared FS does not read telemetry clocks or
allocate telemetry events.

The manual benchmark creates one 500-file donor and 15 sequential fresh
joiners, then prints p50/p95/max milestones and fast/slow overlay-ready
clusters. It waits for write readiness as well as readability, so a slow-path
sample can take several minutes. It is excluded from normal test runs:

```bash
PEERBIT_SHARED_FS_COLD_JOIN_BENCH=1 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/bootstrap-bench.bench.test.ts --reporter=verbose
```

Set `PEERBIT_SHARED_FS_COLD_JOIN_RUNS` to an integer from 10 through 20. The
fast/slow split defaults to 2500 ms and can be changed with
`PEERBIT_SHARED_FS_COLD_JOIN_SLOW_MS`; it is descriptive output, not a pass/fail
latency assertion.

For sustained collaboration, a separate manual benchmark runs three
disk-backed, authenticated full replicas and makes all three write manifested
batches concurrently. It waits for each exact changeset and its bytes on every
replica, prints every round immediately, and finishes with p50/p95/max local
commit, all-peer admission, and all-peer readability latency plus throughput:

```bash
PEERBIT_SHARED_FS_MULTI_WRITER_BENCH=1 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/multi-writer-soak.bench.test.ts --reporter=verbose
```

The default is 30 rounds per writer. Set
`PEERBIT_SHARED_FS_MULTI_WRITER_ROUNDS` to an integer from 10 through 200 for a
shorter diagnostic or a longer soak. This benchmark uses normal write
readiness and disables remote chunk fallback; it does not use the
`allowPartialWrites` recovery escape hatch.

File content is content-addressed: a chunk's id is the hash of its bytes, so
identical content — across versions of one file or across different files — is
stored and replicated exactly once, saving an unchanged file is a no-op, and a
small edit to a large file stores only the changed chunks (fixed-size
chunking: in-place edits dedupe; inserts shift subsequent chunks). Chunk
documents are self-certifying — peers reject any chunk whose bytes do not hash
to its id, at replication time and again on read. Note the standard dedup
trade-off: chunk ids reveal content equality, so anyone with the filesystem
address can confirm whether known content exists in it.

When `rootKey` is provided while creating a filesystem, writes are
access-controlled by a trusted-writer graph rooted at that key. Entries must be
signed by a trusted Peerbit identity, and the stored `authorKey` must match the
entry signer. Use `authorizeWriter(publicKey)` to trust another writer.

Storage is bounded by explicit garbage collection: `collectGarbage()` /
`peerbit-fs gc` retires superseded versions (keeping the newest K, everything
recent, all conflict heads, and anything a delete-vs-edit conflict may need),
compacts settled naming histories, and deletes chunks no surviving version
references. Safety over speed: winners never change (depths are stored, not
recomputed), a two-run ledger barrier keeps a freshly-synced replica from
collecting anything, every replica resurrects removed documents it still
needs, and writers re-verify chunk presence after every save. Version and
naming GC reclaim index rows and per-operation CPU; chunk GC reclaims real
bytes (metadata deletions each leave a small permanent log tombstone). Purges
and chunk-byte reclamation always take effect on a later run — the first run
records candidates; `--immediate-sweep` waives only the time span between
runs, never the second run itself.

## CLI

The companion `@peerbit/shared-fs-cli` package installs `peerbit-fs` for native
mounts:

```bash
npm install -g --omit=peer @peerbit/shared-fs-cli
peerbit-fs install-adapter
peerbit-fs status
```

Then create and mount an authenticated filesystem:

```bash
ADDRESS=$(peerbit-fs create)
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

The CLI commands are:

```bash
peerbit-fs create
peerbit-fs create --no-auth
peerbit-fs whoami
peerbit-fs trust <address> <public-key>
peerbit-fs trust-legacy-replica <address> --assume-local-replica-complete
peerbit-fs install-adapter
peerbit-fs mount <address> <mountpoint>
peerbit-fs mount <address> <mountpoint> --native-adapter peerbit-shared-fs-native
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs benchmark [address]
peerbit-fs unmount <mountpoint>
peerbit-fs prepare-disposal <address>
```

Mounted writes are buffered by the native adapter and committed as one signed
Peerbit file version on `flush`, `fsync`, or `release`/close. The CLI waits for
write readiness before exposing the mount and rejects `mount --no-replicate`.

`peerbit-fs create` is access-controlled by default. Use `peerbit-fs create
--no-auth` only for explicitly unauthenticated test/demo filesystems. Another
machine can join by running `peerbit-fs whoami`; an authorized writer can then
run `peerbit-fs trust <address> <public-key>`.

From this repository on macOS, the local development install path is:

```bash
pnpm shared-fs:install:macos
export PATH="$HOME/.local/bin:$PATH"
peerbit-fs status
```

## Benchmark Baseline

`runSharedFsBenchmark(fs)` and `peerbit-fs benchmark` run a simple baseline
workload: one large file upload/download plus a many-small-files write/list/read
pass. This is meant to track regressions and guide future agent/code workspace
work; v0 does not optimize the small-file workload yet.

## Native Mounts

The TypeScript Peerbit side exposes a small POSIX-ish backend and a local
JSON-lines IPC protocol with `getattr`, `readdir`, `open`, `read`, `write`,
`truncate`, `flush`, `fsync`, `release`, `mkdir`, `rmdir`, `rename`, and
`unlink`. Numeric open flags are parsed with the host platform's `O_*`
constants, truncate shrinks and zero-fill grows both open handles and paths,
and flushing unchanged content does not mint a new version. Writable opens load
the exact visible version rather than a temporarily available ancestor, retain
that version as their sole causal base, and compare-and-set the path's node id
at commit. A remove/recreate race returns `EAGAIN` without editing the
replacement; other conflict heads remain preserved.
Run `peerbit-fs status` to report the current host platform, selected adapter,
and any missing native mount prerequisites.

The first adapter path is intentionally experimental:

- Linux requires FUSE/libfuse plus `fuse-native` or the external adapter.
- macOS requires macFUSE plus `fuse-native` or the external adapter.
- Windows requires WinFsp plus the external adapter.
- `packages/shared-fs/native` provides an experimental external native adapter
  binary using cgofuse for Linux FUSE, macFUSE, and WinFsp.
  `peerbit-fs install-adapter` downloads the matching prebuilt adapter when a
  release asset exists.

Portable CI covers the shared backend and IPC contract on Linux, macOS, and
Windows, plus a cross-OS interop workflow where all three runners join one
shared filesystem address and read each other's files. The native Linux FUSE
smoke can be run manually with the `Shared FS Native Smoke` workflow. Native
adapter compile checks run in CI for Linux and Windows; macOS native mount smoke
still needs a runner with macFUSE installed.

## Conflicts

Concurrent saves remain addressable versions. The visible file version is only
a deterministic display choice. Conflicting versions are listed through
`conflicts()` and exposed to mount adapters below:

```text
/.peerbit-conflicts/<encoded-path>/<version-id>
```

## Watching for changes

`watch()` subscribes to filesystem-shaped change events for a path or
subtree — no polling, no document plumbing:

```ts
const watcher = fs.watch("/project", { settleMs: 20 });
watcher.on("change", (batch) => {
    for (const event of batch) {
        // { type: "created"|"modified"|"deleted"|"renamed", path, oldPath?,
        //   nodeId, parentId, kind, versionId?, changesetId?, author?,
        //   origin: "local"|"remote", cause }
    }
});
await watcher.ready; // initial view committed
// or: for await (const batch of watcher) { ... }
watcher.close();
```

Events describe transitions of the view the read API serves — winner
elections, renames, deletes, and remote arrivals included — and every event
carries write-set attribution (`changesetId`, `author`). Batches are the
delivery unit: everything inside one settle window (`settleMs`, default 20 ms;
`0` = microtask latency) coalesces, a whole `writeBatch` typically arrives as
one batch, and applying a batch in order to a path-keyed mirror reproduces
`list()` exactly (a directory `deleted`/`renamed` moves its whole subtree —
descendants get no individual events). Garbage collection, history
retirement, and resurrection-guard churn emit nothing.

Options: `recursive` (default true), `initial: "snapshot"` to receive the
existing tree as a first batch, `maxNodes` (view budget, default 100k —
exceeding it errors the watcher with `EWATCHLIMIT`), `guardHoldMs` (quiet
hold on removal-caused losses while the resurrection guard settles), and
`signal`. On an ignore-aware handle the stream is filtered by that handle's
policy (rule changes reconcile with `cause: "policy"` events);
`includeIgnored: true` bypasses. Watchers are in-memory; a reopened process
re-subscribes (use `initial: "snapshot"` as the recovery idiom).

## Write-set barriers

A batch written with `manifest: true` publishes a **changeset manifest** —
an inner-signed record of the batch's exact membership, committed after
every member so a crashed prefix never certifies. Any replica can then
gate on the turn:

```ts
const { changesetId, manifest } = await fs.writeBatch(entries, {
    changesetId: "turn-42",
    manifest: true,
});
// announce (changesetId, manifest.manifestId) to consumers, then:
const status = await other.awaitChangeset("turn-42", {
    manifestId: manifest.manifestId, // exact, unforgeable barrier
});
// status.complete === true: every member document of the turn was
// admitted here and the metadata is readable NOW (list/stat/versions see
// the whole turn; readFile may still fetch bytes remotely).
```

`complete` means every member was **admitted on this replica** — not that
members are the visible winners (concurrent writes may supersede), and
not global completeness. Retrying a crashed batch under the same
`changesetId` is safe: no-op entries adopt the young documents that
already satisfy them, so the retry's manifest certifies the real turn.
Manifest-scoped barriers cannot be satisfied or extended by any other
writer (member ids are unguessable and inner-signed); the unscoped form
spans all known manifests for the id (set-union semantics) and is
documented best-effort under id reuse. Barriers default to a 30 s timeout
(`timeoutMs: Infinity` opts out) and reject with the full status
attached; historic turns whose members were garbage-collected resolve
`"collected-or-incomplete"` rather than hanging — barriers cover
propagation windows, not archaeology. `changesetStatus()` snapshots the
same view; `watchChangesets()` streams `manifest` and once-per-transition
`complete` events (queued during a bootstrap overlay so a triggered read
always sees the whole turn). Manifests are retired by `collectGarbage`
once their local arrival age exceeds the retention window.

## Preparing a machine for disposal

Before permanently deleting a machine's Peerbit state, fence the filesystem's
captured recoverable head closure with persisted delivery receipts. The closure
contains every current naming head (including tombstones and conflicts), every
current file-version head, every distinct chunk those versions reference, and
every current trusted-writer log entry (live grants and revocation tombstones).
It does not preserve already superseded filesystem history or control
manifests:

```ts
const result = await fs.prepareForDisposal({
    minAcks: 1,
    timeout: 120_000,
});
// result.safeToDispose === true
```

For a mounted filesystem, stop new writes first and use the CLI barrier before
disposing of the machine or deleting its state:

```bash
# In the original mount terminal, send Ctrl-C/SIGTERM and wait for
# `peerbit-fs mount` to finish its clean shutdown.
peerbit-fs prepare-disposal "$ADDRESS" --min-acks 1
# Only after both commands exit successfully, dispose of the machine or its state.
```

`peerbit-fs unmount "$MOUNTPOINT"` only detaches the OS mountpoint; it does not
stop a separately running `peerbit-fs mount` process. If manual unmounting is
needed, still terminate that original process and wait for it to exit before
running the barrier against the same Peerbit state directory.

`--min-acks` defaults to `1`; `--timeout-ms <number>` sets an overall deadline
for the barrier after the filesystem has opened, and `--json` emits a
machine-readable result. Network connection, filesystem open, and shutdown are
outside that flag's deadline. Any timeout, abort, error, or nonzero exit means
**not safe to dispose**: keep the source machine and its state, fix connectivity
or capacity, and retry the barrier. Retrying is safe because the barrier appends
no logical filesystem mutation. The command must run against the existing full
local replica; `--no-replicate` is rejected. It waits for any pending bootstrap
decision and rejects a bootstrapping or unverified view. Any filesystem-content
or trusted-writer-graph arrival during the fence also fails the attempt. A
deferred resurrection-guard decision for removed live metadata also fails
closed until it settles. Let replication and guard recovery settle, then retry
rather than disposing a moving or temporarily incomplete source. Avoid tight
retry loops after a timeout or abort: already-started local index/log reads
cannot be cancelled and finish in the background.

The guarantee is deliberately narrow:

- The requested quorum applies independently to every exact chunk, version,
  naming, and trusted-writer entry. It does not guarantee that one common
  remote custodian (or the same set of custodians) holds every entry.
- `minAcks` does not increase the filesystem's replication degree. Only
  capable remote leaders backed by supported durable storage count; older,
  incapable, in-memory, or local peers cannot satisfy the requested
  acknowledgements.
- A receipt proves crash-safe persistence at the instant it is issued by a
  cooperative remote. It is not permanent custody, a Byzantine proof, or a
  promise that the remote will remain online or retain the data forever.
- An empty captured state returns a vacuous success (`empty: true`); it
  acknowledges no data and provides no evidence that a remote peer was present.
- The barrier does not revoke this machine's writer key. It durably fences the
  authorization and revocation state that already exists when its stable
  closure is captured; callers must perform any intended revocation first. A
  cold receipt target that never admitted the original grant may be unable to
  validate its revocation tombstone, in which case the barrier fails closed.

This is stronger than a changeset barrier: `awaitChangeset()` proves local
admission and readability, while `prepareForDisposal()` requests persisted
remote delivery for every entry in the captured disposal closure.

## Unattended lifecycle

Full replicas garbage-collect themselves: `collectGarbage` runs on a
jittered schedule (default every 6 h, first run spread over minutes to
~95 min so fleets never herd), and the executing half of the two-run
chunk/purge barrier is chained automatically once candidates mature.
Disable with `gc: false` (or `gc: { schedule: false }`); tune with
`gc: { intervalMs, initialDelayMs, jitterRatio, run }`. Observe via
`gcStatus()` and the `gc:run` / `gc:error` events on `program.events`.

```ts
const fs = await openSharedFs({
    peerbit,
    address,
    gc: { intervalMs: 6 * 3600_000, run: { keepVersions: 5 } },
});
fs.program.events.addEventListener("gc:run", (e) =>
    console.log(e.detail.trigger, e.detail.report.deletedChunks)
);
```

Notes on scheduled runs:

- `run` options are allowlisted: `dryRun`, `nowMs`, and
  `chunkSweep: "immediate"` are stripped (each would be unsafe on
  autopilot); manual `collectGarbage` calls keep them all. A `run.scope`
  means everything **outside** the scope never GCs on this schedule.
- Every run inherits the HEAL phase's full chunk probe (each chunk of
  each surviving version), so the default cadence probes the store four
  times a day — budget disk latency accordingly on very large stores.
- An unverified replica with no peer evidence (no connections, no recent
  arrivals) defers scheduled runs rather than collecting against a
  partitioned view; manual runs stay available.
- A follow-up timer does not survive restart: persisted candidates
  simply mature and execute on the first post-restart run.

Naming history compacts even under active heads: a head only needs to
have been **visible locally** for `namingHeadStabilityMs` (default 1 h;
arrival-based, so author-stamp backdating cannot force compaction), and
at most `namingCompactionBatchLimit` events retire per node per run
(default 500, shallowest-first) so upgrade-day backlogs drain in bounded
bursts.

Superseded snapshot **segment blocks** are reclaimed too, after a grace
period (`snapshot: { segmentReclaim: { graceMs } }`, default 3 h,
disable with `segmentReclaim: false`). Only positively recorded own
segments are ever deleted, re-verified at deletion time against every
locally known live manifest — identical content across authors dedups
to identical cids, and another author's live manifest protects them.
Fleet caveats:

- The grace is floored at the bootstrap staleness cap
  (`maxSnapshotAgeMs`, 2 h): keep that cap **fleet-consistent**, or a
  joiner configured with a larger cap can select a manifest whose
  segments were already reaped (it then falls back to log replication —
  degraded, not lost).
- The segment ledger lives beside the store
  (`shared-fs-snapshots/<address>.json`); peers without a directory keep
  it in memory, matching their in-memory block store.
- Generations published before this feature were never recorded and are
  permanently exempt (the positive-record safety rule): a one-time bloat
  that stops growing. Wipe the block store and re-replicate to reclaim
  it.
