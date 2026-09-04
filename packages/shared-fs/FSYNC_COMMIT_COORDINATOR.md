# Mounted fsync commit coordinator: safety design

Status: design and report-only benchmark. There is deliberately no production
coordinator in the v9 mount backend yet.

## Goal

Small independent mounted writes currently cross the document/log persistence
path once per file. A coordinator could collect already-fenced snapshots from
different file states and use one bounded lower-level batch append. The target
is lower aggregate `fsync`/`flush` latency without changing what a successful
fence means.

The coordinator must remain opt-in until native Ubuntu, macOS, and Windows
crash tests and mounted benchmarks justify enabling it. Suggested initial
bounds are 16 entries, 4 MiB of immutable input, and a 1 ms maximum collection
window. A full batch must launch immediately when either entry or byte bound is
reached.

## Why `writeBatch` cannot be used as the coordinator today

`SharedFileSystem.writeBatch()` is an intentionally different API, not a
vector form of the native-mount write capability:

- It resolves each file's current node and current content heads inside the
  batch. A mount fence must instead retain the exact node, explicit base
  version, and complete head set captured by the writable open. Absorbing a
  newer head would erase the conflict that a stale mounted edit must expose.
- It has no atomic `expectedNodeId` or expected-parent guard. A path replaced
  while bytes and chunks are prepared must make only that stale descriptor
  fail; it must never publish through the replacement path.
- Its unchanged result is `undefined`. The mount capability needs a validated
  `unchanged` or `created` outcome with exact version, node, and content-hash
  metadata before it may advance a state's persisted generation.
- It returns one batch-wide rejection. The documented batch is
  non-transactional across files, so a failed call may have committed a
  prefix. Reissuing ordinary entries can mint fresh version ids or choose new
  parents, making replay ambiguous.
- New-file visibility needs a later naming event. Mixing provisional creates
  into the first coordinator generation would add a second partial-commit
  boundary and expected-parent races. The first safe version should therefore
  batch existing named file nodes only.

The lower document `putMany` path does provide the useful append/index
amortization. It does not, at the SharedFS boundary, provide a stable prepared
operation token or per-document definite-commit result after every failure
point. Calling it directly from `mount-backend.ts` would also bypass chunk,
authorization, lifecycle, cache, and namespace invariants owned by
`SharedFileSystem`.

## Required capability boundary

A safe implementation needs a new, explicitly versioned target handshake; it
must not infer support from the presence of `writeBatch`:

```ts
type PreparedMountWrite = {
    operationId: string; // stable across an in-process retry
    path: string;
    expectedNodeId: string; // existing files only in v1
    baseVersionIds: readonly [string];
    openedHeadVersionIds: readonly string[];
    bytes: Uint8Array; // immutable until final outcome
};

type MountWriteBatchOutcome =
    | {
          type: "unchanged";
          versionId: string;
          nodeId: string;
          contentHash: string;
      }
    | {
          type: "created";
          versionId: string;
          nodeId: string;
          contentHash: string;
      }
    | { type: "rejected"; error: unknown; definitelyCommitted: false };
```

The actual API should separate prepare from commit, or otherwise guarantee
that the same `operationId` always reuses the same signed version identity.
The target must:

1. validate and copy/retain the complete immutable invocation before its first
   asynchronous boundary;
2. preflight each path/node independently and omit only mismatches;
3. hash each input and apply exact-head no-op rules identical to
   `writeFile(..., { noOpIfHeadVersionIds })`;
4. preserve the supplied explicit base even when another writer advances the
   current heads during preparation;
5. touch and recheck chunks with the existing GC barriers;
6. recheck every expected node immediately before and after version
   publication;
7. batch only the surviving version documents through the existing document
   batch append;
8. return a definite per-operation outcome, using stable prepared ids to
   reconcile or replay the exact document after an ambiguous lower-layer
   error; and
9. enter the existing foreground-mutation critical tail before publication so
   close/reopen joins the entire batch.

One malformed or stale request can be rejected before publication while the
remaining independent requests proceed. A lower-level failure whose individual
commit set cannot be proven must fail closed as `unknown`: the backend must
retain the prepared identity and may only retry that exact operation, never
mint a replacement version. This likely requires a small addition to the
document append API to expose per-entry local commit evidence after recovery.

## Backend coordinator state machine

Each queued item owns `(OpenFileState, generation cutoff, immutable snapshot,
operationId)`. Setting `state.committing` happens synchronously when the first
fence queues the item, before a collection timer or microtask. That preserves
the existing open/rename/remove exclusion. Later fences on the same state join
that item when their cutoff is covered; a later generation queues only after
the earlier outcome updates the state's exact causal base.

The coordinator has four states: `accepting`, `draining`, `closing`, and
`closed`.

- `accepting` admits bounded independent existing-file items.
- `draining` owns a detached batch; new work goes into the next bounded batch.
- `closing` rejects new admission, cancels collection timers, rejects queued
  items that have not entered target publication, and joins every launched
  target call.
- `closed` holds no timers, borrowed buffers, waiters, or launched work.

`flush`, `fsync`, and `release` still resolve separately. Each promise resolves
only after its own validated target outcome advances its state's persisted
generation through its captured cutoff. A failure for another path cannot
reject it. A batch-level unknown may reject all unresolved members, but their
prepared identities remain attached for exact retry.

The mount backend needs an explicit asynchronous shutdown hook. CLI teardown
must stop native/IPC admission, call that hook, and only then stop Peerbit.
Release-time errors remain observable; shutdown must aggregate rather than
drop launched failures. The default uncoordinated path must remain byte-for-byte
unchanged when the option is absent.

## Test gates before implementation can ship

- Same-state generations: an older fence cannot include or clear a later
  sibling write, and a later fence cannot overtake the older causal update.
- Independent failure: one expected-node mismatch rejects only that state and
  cannot block successful siblings.
- Exact conflict: a remote same-node head arriving between open and batched
  publication remains a sibling head; it is never adopted as a parent.
- Replacement race: remove/recreate during preparation yields `EAGAIN` and no
  bytes become visible through the replacement node.
- Ambiguous append failure: injected failure before append, after append, and
  after index admission retries the same prepared identity and creates at most
  one version.
- Crash recovery: kill immediately after the lower batch commit and verify
  that every acknowledged fence is readable after reopen, while unacknowledged
  items are either absent or recoverable by their exact operation identity.
- Shutdown: queued work cancels, launched work drains, retained immutable
  buffers detach, and no timer or rejection survives teardown.
- Native three-OS tests: concurrent file-handle `fsync`, `flush`, release,
  process kill, and adapter teardown without timeout inflation or blind retry.

## Benchmark

The manual benchmark described in the library README compares today's exact
mounted fence path with `writeBatch` as an explicitly unsafe performance
ceiling. It reports document `put`/`putMany` calls, completion-signal shape,
node/base guard coverage, version growth, conflicts, and wall time. The ceiling
is evidence about possible append amortization only; it is not a candidate
implementation and must never be reported as equivalent filesystem semantics.

For novel one-chunk files, the structural report is especially important:
today's exact path issues two document `put` calls per file (chunk, then
version), while the ceiling still issues one chunk `put` per file and batches
only the version documents into one `putMany`. Concurrent exact commits already
overlap independent work. A coordinator therefore cannot assume that replacing
the version calls alone yields a useful wall-time or tail-latency win. A
separate, correctness-preserving chunk-touch batch may be a prerequisite, and
the measured native three-OS result—not call count—must decide promotion.
