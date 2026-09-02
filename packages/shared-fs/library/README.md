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
edit is recoverable, not lost. Operator workflows can pass the complete
conflicts involving the target as `{ expectedConflicts }` in the third
argument. The library rechecks the exact local conflict topology immediately
before deriving the action, including other duplicate-name claimants and
recoverable delete-vs-edit versions. A changed view fails retryably with
`SharedFsExpectedNamingConflictMismatchError`. Guarded delete/restore actions
snapshot content before that final check and only acknowledge/supersede those
heads; content arriving later remains recoverable or concurrent.

## Node-guarded mount namespace mutations

Native mounts negotiate
`SHARED_FS_MOUNT_NAMESPACE_SEMANTICS` (`"node-guarded-namespace-v1"`) before
using `mutateNamespaceForMount()`. The additive API accepts either a `remove`
bound to an exact path, node id, and kind, or a `rename` bound to the exact
source node, destination node (or absence), destination-parent node, and every
active open descendant supplied by the mount. It returns the exact removed
node/event ids or the renamed source, replaced node, parent, move-event, and
replacement-delete-event ids. A changed binding or naming-head set throws
`SharedFsExpectedNamespaceMismatchError` (`EAGAIN`) with the operation, path
role, expected/actual node ids, and `initial` or `before-append` checkpoint.

This capability is a compare-and-set fence over this replica's visible CRDT
state, not a linearizable distributed transaction or a global no-resurrection
proof. A concurrent delete/rename not yet visible locally may still conflict
after the guarded append; the existing naming conflict rules, including the
non-delete preference, are deliberately unchanged. Rename-over-file emits the
replacement tombstone and source move together with `putMany`, but remote
replicas still ingest immutable events incrementally. Wrappers must explicitly
preserve policy and re-advertise the exact capability; ordinary `rm()` and
`rename()` retain their existing local-first behavior.

Within one program instance, a guarded mutation fences local ordinary naming
appends from validation through publication. Overlapping `mkdir`, `rm`,
`rename`, file creation, naming-producing `writeBatch`, and conflict-resolution
plans fail retryably with `EAGAIN`; an epoch check also rejects an ordinary plan
that observed namespace state before the guarded fence and tries to publish
after it. Already-admitted naming appends drain before the guarded mutation
reads state, while background safety repair waits for the fence rather than
dropping its work. Close cancels pending repair timers and joins or explicitly
drains already accepted resurrection work before closing storage. This fence
cannot stop a remote peer's event from arriving; such arrivals are revalidated
when visible before append, while events not yet visible remain subject to the
CRDT limitation above.

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

For a stronger lifecycle boundary, the process-isolated soak runs three
authenticated, disk-backed full replicas in three separate Node processes over
loopback networking. It measures concurrent manifested batches with metadata
admission separated from byte readability, a mount-style temporary-file
`fsync`/release/rename replacement of a seeded target, deterministic same-base
content conflict and resolution, a normal garbage-collection pass, abrupt
`SIGKILL` of one writer, a no-listener offline reopen and write from that
writer's durable directory, and reconnect. Exact manifests, bytes, editor node
identity, conflict heads, trusted keys, identity reuse, zero fresh-data GC
reclamation, and exact recursive-tree convergence are hard assertions. Latency,
CPU, RSS, and state-directory growth are descriptive output rather than
performance budgets:

```bash
PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK=1 \
PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK_ROUNDS=30 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/process-isolated-soak.bench.test.ts --reporter=verbose
```

Use one round to validate the harness itself; real soak values are integers from
10 through 200. Generated payload bodies default to 4096 bytes and can be set
from 256 bytes through 1 MiB with
`PEERBIT_SHARED_FS_PROCESS_ISOLATED_SOAK_PAYLOAD_BYTES`. The payload stream is
preceded by a small descriptive prefix and is deterministic but unique per file,
writer, and round so content-addressed dedup does not turn storage measurements
into a repeated-content best case. Every
completed round prints `process-isolated-soak-round:` immediately, followed by
one aggregate `process-isolated-soak:` report. The reported state-directory
growth is a descriptive fleet-wide ratio over logical bytes written, not a
write-amplification claim. All replicas keep scheduled GC enabled, while the
explicit measured GC pass uses normal retention, so a short run exercises
planning and safety without pretending newly written data should be reclaimed.
The campaign uses `bootstrap: false` and disables remote chunk fallback: it is a
steady-state and warm-restart complement to the separate cold-join benchmark,
not a retry of that benchmark. It also deliberately avoids
`prepareForDisposal()`, whose persisted-receipt session recovery is tracked
separately upstream.

The mount backend's manual copy-on-write benchmark isolates 4, 64, and 256 MiB
commit buffers behind a gated fake target that retains the immutable commit
input after resolution. For every size it runs a legacy fallback (mount and
target each SHA-256 the full input) and the versioned capable path (only the
target hashes it) in fresh `--expose-gc` children. It reports paired commit
entry times, the target's measured hash time, first post-commit mutation time,
and RSS/external/ArrayBuffer memory snapshots and deltas. This deliberately
uses a new/truncated file and a fake target: it isolates mount commit hashing
and COW allocation, not writable-open hashing, SharedFileSystem chunk hashing,
authorization, replication, or storage IO. The numbers are descriptive only;
there are no performance budgets. Exact unchanged writes still perform one
full-file hash in either mode (in the mount for fallback, in SharedFileSystem
for the capable path); the duplicate-pass saving applies to version-creating
commits:

```bash
PEERBIT_SHARED_FS_MOUNT_COW_BENCH=1 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/mount-backend-cow.bench.test.ts --reporter=verbose
```

The separate writable-open benchmark isolates the exact-version read path for
existing 4, 64, and 256 MiB files. In both modes its fake target allocates one
fresh snapshot and performs one whole-file SHA-256 verification, modeling
`SharedFileSystem.readVersion()` after chunk assembly. The fallback mount then
hashes those bytes again for its local no-op baseline; the versioned verified
path returns strictly bound version/node/hash/size metadata and reuses the
target's verified hash without another byte copy or hash. It reports five-run
p50 open, target-copy, and target-hash times plus a descriptive paired delta.
It does not model chunk fetch/verification, Peerbit document resolution,
authorization, replication, storage IO, commits, or read-buffer copies, and it
has no timing budget:

```bash
PEERBIT_SHARED_FS_MOUNT_OPEN_BENCH=1 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/mount-backend-open-hash.bench.test.ts --reporter=verbose
```

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
peerbit-fs naming-conflicts <address>
peerbit-fs resolve-conflict <address> <path> <version-id>
peerbit-fs resolve-naming-conflict <address> <node-id> <keep|restore|delete|move>
peerbit-fs benchmark [address]
peerbit-fs unmount <mountpoint>
peerbit-fs prepare-disposal <address>
```

`conflicts --json` exposes every content head in the converged local view in a
document carrying address/filter/view metadata plus a `conflicts` array. The
records include actionable version ids and bigint metadata encoded as decimal
strings. Observer mode can inspect an existing local store but its
`fullReplica: false` view does not prove completeness.
`naming-conflicts --json` exposes each conflict type, visible winner node,
naming event ids, shadowed claimant ids, and recoverable content ids. Content
resolution explicitly selects one current head; naming resolution accepts
`keep`, `restore`, `delete`, or `move --to <path>`. For duplicate names,
normally move or delete a listed shadowed claimant: keeping the visible winner
alone does not remove the other claim. Delete-vs-edit conflicts can be restored
with their concurrent content intact, while unreachable nodes normally need a
move to a reachable parent or deletion.

The two resolution commands require a full write-ready replica and a trusted
local writer. They reject ids outside the currently visible local conflict;
naming resolution also supplies the complete `expectedConflicts` topology so a
change to the target, another duplicate-name claimant, or recoverable content
visible at execution fails retryably instead of accepting a stale action. That
is not a global transaction: a later arrival stays concurrent and may
re-conflict. Inspect again after every action. Resolution
also does not request persisted remote receipts; use `prepare-disposal`
separately before retiring that machine. `status --json` emits one document
with native support, and `--include-conflicts` opts into separate content and
naming counts/records. The scans are omitted by default because they scale with
retained metadata; naming `--path` likewise filters output only after a
whole-namespace conflict scan.

Mounted writes are buffered by the native adapter. Each successful `flush` or
`fsync` persists through the mutation generation captured when its fence
starts. Backend-local descriptors for the same current file-node/path binding
share one buffer, logical length, mutation generation, and commit ancestry;
access mode, `O_APPEND`, and closing remain descriptor-local. A remote removal,
replacement, or move detaches the old binding: its existing descriptors retain
local-only bytes until close while a later open receives a fresh attached
state. `release` closes writes through that descriptor before persisting its
cutoff. Later writes through sibling descriptors stay dirty for the next fence
instead of starving the current one. The CLI waits for write readiness before
exposing the mount and rejects `mount --no-replicate`.

This mount fence is not a remote durability quorum. In particular, `fsync`
does not call `prepareForDisposal()` and does not wait for persisted receipts
from another machine. Portable CI verifies recovery of the default disk-backed
Peerbit store after forced process termination immediately following `fsync`,
but that is not a claim that every custom mount target survives host power loss.

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

The manual shared-open benchmark runs with:

```bash
PEERBIT_SHARED_FS_SHARED_OPEN_BENCH=1 \
pnpm --filter @peerbit/shared-fs exec vitest run \
  src/__tests__/mount-backend-shared-open.bench.test.ts --reporter=verbose
```

It uses isolated `--expose-gc` processes to compare one and eight simultaneous
read-only descriptors for the same 64 MiB file. Both cases must perform exactly
one target-side verified read and SHA-256 hash, perform no target write on
release, and retain one file-sized `process.memoryUsage().arrayBuffers`
allocation. The eight-descriptor retained delta is bounded to the
one-descriptor delta plus 10% and a small fixed allocator allowance; after the
last release both cases must return close to their baseline. Open time is
reported for diagnosis only and has no pass/fail budget.

## Native Mounts

The TypeScript Peerbit side exposes a small POSIX-ish backend and a local
JSON-lines IPC protocol with `getattr`, `readdir`, `open`, `read`, `write`,
`truncate`, `flush`, `fsync`, `release`, `mkdir`, `rmdir`, `rename`, and
`unlink`. Numeric open flags are parsed with the host platform's `O_*`
constants, truncate shrinks and zero-fill grows both open handles and paths,
and flushing unchanged content does not mint a new version. Writable opens load
the exact visible version rather than a temporarily available ancestor, retain
that version as their sole causal base, and compare-and-set the path's node id
at commit. A verified-read-capable target also lets a read-only first opener
establish that exact shared snapshot once; legacy targets retain their
`readFile` availability fallback and upgrade coherently on the first writable
attach. A typed remove/recreate mismatch quarantines every descriptor for the
old local state, so repairing the path cannot make a retry publish stale bytes;
other conflict heads remain preserved.
Run `peerbit-fs status` to report the current host platform, selected adapter,
and any missing native mount prerequisites.

Open access modes are enforced per handle: wrong-direction reads, writes, and
handle truncates return `EBADF`; missing writable opens require `O_CREAT`; and
the portable fail-closed result for `O_RDONLY|O_TRUNC` is `EINVAL`. A read-only
`O_CREAT` handle materializes an empty file at its first successful
`flush`/`fsync`/release commit fence. `O_APPEND` relocates each write to the
then-current end of the shared backend-local file state. Sibling append
descriptors therefore allocate non-overlapping ranges atomically within one
backend process. This is not a distributed append lock: different backends or
peers can still publish conflict versions rather than a globally concatenated
stream. A zero-byte write never allocates a sparse gap, changes length, or
creates a commit generation.

One backend process keeps one attached, shareable state for each current
file-node/path binding, even when several descriptors are open. A remote
replacement or move can detach an older state: its still-open descriptors keep
their local-only bytes until their last close, but the detached state is
excluded from path overlays and commits while a fresh attached state loads for
the observed binding. Attached state is removed after its last descriptor
releases (or a typed node mismatch quarantines it), so a later open loads and
verifies a fresh snapshot rather than retaining an unbounded inode cache.

`O_CREAT|O_EXCL` excludes settled paths and backend-local pending creators with
`EEXIST`. Ordinary sibling opens attach to the same provisional file state,
observe each other's writes immediately, and share its single serialized
commit chain. This prevents separate local expected-absent commits from
forming artificial conflict heads. It is not a distributed lock or globally
linearizable open:
disconnected or concurrently replicating peers can each observe an absent
path, successfully create distinct nodes, and later expose the duplicate name
through the normal conflict model. Creation remains
commit-on-flush/fsync/release, so a race discovered after open can surface at
that later fence. A confirmed absent-path loser is terminal and cannot recreate
the path after the winner is removed; unrelated `EIO` and readiness failures
remain retryable. Targets advertising the versioned native-mount write
capability translate an exclusive commit-time loss to `EEXIST`; custom targets
retain their original `EAGAIN` result.

Custom mount targets that implement `expectedNodeId` compare-and-set should
throw the exported `SharedFsExpectedNodeMismatchError` for an atomic mismatch.
The mount uses that discriminator to terminalize both an absent-path loser and
an existing file state whose node was replaced, without a racy follow-up
lookup; unrelated or untyped `EAGAIN` failures remain retryable.
An initially absent nested create also captures the exact parent directory node
while holding its reservation. If that built-in parent disappears, becomes a
file, or is replaced by another directory node before the naming fence, the
structured terminal `ENOENT`/`ENOTDIR`/`EAGAIN` result closes the old handle;
generic custom-target failures with those codes remain retryable.

Backend-local pending or in-flight absent-path creates temporarily gate
`mkdir`, `rmdir`, `unlink`, and both the source and destination namespaces of
`rename` with `EAGAIN`. This prevents a buffered creator from resurrecting a
path after a competing namespace operation; retry the namespace operation after
the create fence settles. Overlapping backend-local namespace transitions are
also serialized with temporary `EAGAIN`, so chained renames cannot leave open
handle paths behind. An external-adapter `Mknod` whose one-shot release fails is
discarded so its unreachable exclusive reservation cannot block a later retry.
Normal open handles retain buffered data and reservations across transient
release failures.

The first adapter path is intentionally experimental:

- Linux requires FUSE/libfuse plus `fuse-native` or the external adapter.
- macOS requires macFUSE plus `fuse-native` or the external adapter.
- Windows requires WinFsp plus the external adapter.
- `packages/shared-fs/native` provides an experimental external native adapter
  binary using cgofuse for Linux FUSE, macFUSE, and WinFsp.
  `peerbit-fs install-adapter` downloads the matching prebuilt adapter when a
  release asset exists.

The external adapter forwards the flags supplied at its cgofuse callback
boundary. Linux FUSE and macFUSE retain creation and status flags for `Create`;
WinFsp translates Windows access, append, and overwrite semantics above FUSE
and synthesizes its `Create` flags. The `fuse-native` API exposes flags for
`open` but not for its `create` callback, so that shim conservatively requests
read/write/create/exclusive access without truncation. It cannot preserve the
caller's requested access mode or `O_APPEND` during creation, and an ordinary
`O_CREAT` race may therefore return `EEXIST`. Use the external adapter when
its platform translation is required.

The portable backend gives `flush` and `fsync` the same bounded file-state
fence: each captures a synchronous mutation-generation cutoff and persists
every generation accepted before that call. `release` first closes mutation
admission through that descriptor, then persists the same kind of cutoff before
detaching it. Mutations admitted later through sibling descriptors remain
buffered for a later fence. The current target interface still has no
backend-independent hardware cache or power-loss barrier.

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

The portable durability campaign also exercises the operational boundary: it
forces the three authenticated replica instances to terminate without
`Peerbit.stop()` immediately after a persisted `minAcks: 2` result, deletes the
source directory, and reopens each acknowledged custodian alone with remote
chunk fetching disabled. That proves recovery after application-process death
on the tested disk backend. It does not emulate a kernel/host power cut or
storage-controller cache loss; those require a VM or hardware power-fault
campaign whose storage stack is configured and observed explicitly.

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

Superseded snapshot **segment blocks** can be reclaimed after a grace
period (`snapshot: { segmentReclaim: { graceMs } }`, default 3 h,
disable with `segmentReclaim: false`). Physical deletion runs only when the
open asserts `blockStoreAccess: "store-exclusive"`; `shared` and the default
`unknown` keep snapshot publication available but disable segment reclamation.
An explicit reclaim object without that assertion fails with `EINVAL`. The CLI
leaves access `unknown` because its state directory may contain more than one
filesystem. Only positively recorded own segments are ever deleted, re-verified
at deletion time against every locally known live manifest — identical content
across authors dedups to identical cids, and another author's live manifest
protects them.
Fleet caveats:

- The grace is floored at the bootstrap staleness cap
  (`maxSnapshotAgeMs`, 2 h): keep that cap **fleet-consistent**, or a
  joiner configured with a larger cap can select a manifest whose
  segments were already reaped (it then falls back to log replication —
  degraded, not lost).
- The segment ledger lives beside the store
  (`shared-fs-snapshots/<address>.json`); peers without a directory keep
  it in memory, matching their in-memory block store.
- `store-exclusive` is a store-wide lifetime assertion: this open must be the
  sole owner, publisher, and reaper of every snapshot segment it may delete,
  across every active or inactive program instance and process. Snapshot
  segment bytes are content-addressed and can deduplicate across filesystems,
  while one filesystem cannot discover another's live manifests. The local
  segment-ledger lock therefore cannot establish exclusivity for a physical
  store shared with another filesystem, directory, host, or process. Leave
  access `unknown`, declare it `shared`, or set `segmentReclaim: false` unless
  that exclusivity is guaranteed for the whole open lifetime.
- Dead-lock recovery uses local OS PID liveness and therefore assumes one
  host and PID namespace. Do not share a Peerbit state directory between
  hosts or isolated containers through NFS, SMB, or a host-mounted volume.
  PID reuse fails closed and may leave the ledger locked until that process
  exits.
- Ledger files are fsynced and atomically replaced. POSIX also requires the
  parent-directory fsync to succeed; Windows accepts the documented platform
  errors for unsupported directory fsync, so its tests prove process-crash
  atomicity rather than POSIX-equivalent physical power-loss durability.
- A process crash can leave a token-named candidate, temporary ledger, stale
  lock, or release directory beside the live ledger. These artifacts are inert
  and never interpreted as current state, but one small artifact can accumulate
  per interrupted crash stage.
- A normal Peerbit state directory is single-process. The ledger serializes
  and crash-safely replaces its own sidecar, but it cannot make a custom block
  store safe for two processes that concurrently publish and reap the same
  blocks. Externally serialize those processes or disable `segmentReclaim`.
  If a contended publisher is cancelled after putting a segment but before
  recording its intent, the untracked block is retained safely but can consume
  space.
- Generations published before this feature were never recorded and are
  permanently exempt (the positive-record safety rule): a one-time bloat
  that stops growing. Wipe the block store and re-replicate to reclaim
  it.
