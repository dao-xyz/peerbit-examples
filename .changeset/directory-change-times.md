---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Native mounts report directory mtime and ctime as per-mount change stamps
instead of the directory's creation time, so git's untracked cache, make and
file watchers see when a directory's names change:

- A directory's time changes when a name in it appears, disappears or is
  renamed, whether through this mount or replicated from another peer
  (including naming-conflict winner changes and directory merges), and when
  the directory itself moves. File writes, chmod and utimens inside it, and
  changes deeper in the tree, leave it unchanged. `/` follows the same rule
  instead of reporting the mount time; `.peerbit-conflicts` moves when a fork
  appears or merges and with every name change, which can reveal or hide a
  conflicted file.
- The stamps live in memory, come from the mount's clock and are never
  replicated: no format, IPC or adapter change. A directory shows the time this
  mount first read it or last saw its names change, and a remount makes git's
  untracked cache rescan once. A changed directory moves to the next whole
  second when that is at most 1 s ahead of the clock; a further change within
  that second, after a tool read the first, stays in it. A time never runs
  more than 1 s ahead of the clock, even under bursts of changes and stats.
  `utimens` on a directory is still ignored.
- The Linux mount smoke now requires `git update-index --test-untracked-cache`
  to pass on the mount. `core.untrackedCache` is safe for a `.git` one peer
  uses; set it to `false` for a `.git` several peers use.
- Library: `onNamespaceChange()` on `SharedFileSystem`, `SharedFsHandle` and
  `IgnoreAwareFs` reports namespace-relevant index changes; `stat()` and
  `list()` entries carry `parentId`. Mount backends accept `clock` and
  `servedLimit` options, follow a target's optional `onNamespaceChange()` and
  gain an optional `dispose()`, which `peerbit-fs mount` calls on shutdown.
