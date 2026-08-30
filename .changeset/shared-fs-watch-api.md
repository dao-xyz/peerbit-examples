---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Change notification: `fs.watch(path?, options?)` subscribes to
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
