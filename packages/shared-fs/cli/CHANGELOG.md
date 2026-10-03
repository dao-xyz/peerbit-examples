# @peerbit/shared-fs-cli

## 0.16.4

### Patch Changes

- ca4e7ae: Stop asking each directly connected peer for the filesystem's subscribers on
  open. shared-fs added this in 0.15.0 after a cold join in CI waited 90 s with
  "Path does not exist", because the joiner never learned that the replicator
  next to it held the filesystem. Since the Peerbit 5.4.9 cohort, pubsub covers
  the same neighbours with its own direct exchange: it sends each direct
  neighbour its subscriptions, with a request to answer, when it subscribes and
  when a neighbour's stream opens. In normal operation the shared-fs request is
  therefore redundant.

    A cold-join soak of the multi-party workload with the shared-fs request
    turned off stalled 0 of 1,500 times on Peerbit 5.4.10, against 3 of 542 on
    5.4.6 (Fisher p=0.019; 95% upper bound 0.2%). Cold-join time did not change
    (median 1.41 s without it, 1.47 s with it).

    One induced case is not covered. When a test drops every subscription
    announcement the joiner sends for the log topic, including the direct one to
    its neighbour, and the joiner happens to be that topic's shard root, the join
    stalls without the shared-fs request (10 of 10 runs on 5.4.10) and recovers
    with it (0 of 10). The joiner then finds no snapshot and stays write-gated
    rather than becoming writable. This needs the direct neighbour message itself
    to be lost, which never happened in the soak, and the fix belongs in Peerbit:
    the shard root should announce again once it subscribes. A new test checks
    that pubsub keeps sending the direct exchange.

- Updated dependencies [ca4e7ae]
- Updated dependencies [562dd09]
- Updated dependencies [1555c79]
    - @peerbit/shared-fs@0.16.4

## 0.16.3

### Patch Changes

- d3ba05e: Move to the Peerbit 5.4.10 cohort: peerbit 5.4.10, @peerbit/document 15.1.11,
  @peerbit/program 6.0.68 and @peerbit/trusted-network 6.0.142 (with
  @peerbit/shared-log 16.0.40, @peerbit/log 6.2.38 and @peerbit/pubsub 5.4.13).
  It recovers interrupted replication and drains cancelled joins, and releases a
  failed replay's resources.
- 2bbbacb: Move to the Peerbit 5.4.9 cohort: peerbit 5.4.9, @peerbit/document 15.1.10,
  @peerbit/program 6.0.67 and @peerbit/trusted-network 6.0.141 (with
  @peerbit/shared-log 16.0.39, @peerbit/pubsub 5.4.12 and @peerbit/log 6.2.37).
  Among its fixes, pubsub now exchanges subscriptions directly between neighbours
  whether they bootstrapped or only dialled, so a peer that only dials another
  replicates with it.
- Updated dependencies [d3ba05e]
- Updated dependencies [2bbbacb]
- Updated dependencies [450984a]
    - @peerbit/shared-fs@0.16.3

## 0.16.2

### Patch Changes

- 3c79fa5: Windows mounts create file and directory symlinks, and a delete-on-close file
  disappears when its handle closes:
    - Creating a file link from Windows (`mklink`,
      `New-Item -ItemType SymbolicLink`, `CreateSymbolicLinkW`) failed with access
      denied and left an empty file. WinFsp turns the file it has just created
      into a link by renaming a hidden symlink over it, and the mount refused to
      rename over a file it was still creating. Mount backends now give such a
      file POSIX name semantics: a rename onto it and an unlink of it succeed, and
      its descriptors keep an anonymous file that is never committed. A Windows
      delete-on-close file therefore no longer survives on the mount, and a
      temporary file that is created, unlinked, written and closed through the
      backend is never published. Linux and macOS mounts do not reach this path:
      libfuse renames a still-open file to a hidden name instead of unlinking it,
      which still answers `EAGAIN` for a pending create. An open still in flight,
      a create below the path, a pending create as a rename source and a create
      whose commit is in flight or failed (it may still have published the file)
      still answer `EAGAIN` too.
    - The Windows adapter stores an absolute target on the mount relative to the
      link (`P:\a\b` linked from `P:\a\x\l` becomes `../b`), so the link resolves
      inside every peer's mount and WinFsp can read it back, which it refuses for
      absolute targets.
    - A link to a directory gets the Directory attribute on Windows, so Windows
      lists through it and removes it as a directory. The adapter answers
      WinFsp's `<link>/.` probe with `ENOENT`, so WinFsp stats the link's target
      instead of the link.
    - Still unsupported on Windows: targets off the mount, junctions, hard links,
      and reading a link a POSIX peer created with an absolute target.
    - The hosted Windows mount smoke now gates on file and directory links, an
      absolute target, delete-on-close and no `.fuse_hidden` names left behind.

    The adapter change reaches users through this CLI version's adapter release
    (`shared-fs-native-v<version>`), which the release publishes automatically.
    Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.

- Updated dependencies [3c79fa5]
    - @peerbit/shared-fs@0.16.2

## 0.16.1

### Patch Changes

- f223ca7: Native mounts report directory mtime and ctime as per-mount change stamps
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

- 246161d: macOS native mounts:
    - The adapter reports ready, and `peerbit-fs mount` prints `Mounted`, only once
      the mountpoint is attached. It waits for the kernel's mount event (kqueue
      `EVFILT_FS`) and checks the mount table, without polling. A FUSE runtime that
      calls Init before macOS attaches the mount (FUSE-T does) could otherwise let a
      write right after `Mounted` land in the bare mountpoint directory.
    - `getNativeMountSupport` and `peerbit-fs status` look for the FUSE library the
      adapter will load, in cgofuse's order, instead of only the macFUSE bundle.
      When macFUSE is absent and FUSE-T is installed, the adapter falls back to
      FUSE-T; status now says so and that shared-fs does not test FUSE-T, and the
      adapter mounts it with `-o noattrcache` so the macOS NFS client's attribute
      cache does not hide other peers' changes.

- 246161d: `peerbit-fs mount` no longer fails when the Peerbit bootstrap nodes cannot be
  reached. It warns, mounts from local state and turns on Peerbit's bootstrap
  recovery, which redials with backoff whenever the mount has no connections, at
  startup and after later network loss. Joining a remote filesystem still waits
  for the write-readiness fence, so an offline join fails safely. `--peer` keeps
  the mount off the public network as before.
- Updated dependencies [f223ca7]
- Updated dependencies [246161d]
    - @peerbit/shared-fs@0.16.1

## 0.16.0

### Minor Changes

- 3f34885: Authenticate every native mount IPC connection. On macOS and Windows,
  `peerbit-fs mount` serves the adapter on TCP loopback, and any local user could
  connect to that port, negotiate IPC v2, and read, write, or delete files in
  another user's mounted filesystem.

    `createSharedFsIpcServer` now generates a random 256-bit token for each server
    and exposes it as `token` on the returned server. The IPC v2 negotiation offer
    carries it in a new `token` member. The server compares it in constant time,
    answers an offer without it, or with any other value, with an `EACCES` error,
    and closes the connection before it selects a version or runs any operation.
    The check applies on every endpoint, including the Linux owner-only Unix
    socket, so a private socket path is no longer needed to keep a macOS or
    Windows daemon private. `peerbit-fs mount` hands the token to the adapter it
    starts, managed or chosen with `--native-adapter` or
    `PEERBIT_SHARED_FS_NATIVE_ADAPTER`, in the `PEERBIT_SHARED_FS_IPC_TOKEN`
    environment variable, never in its arguments, which other local users can
    list. The adapter unsets the variable, so no process it starts inherits it.

    Wire break: an adapter from an earlier release does not send the token, so the
    daemon refuses it at mount startup with an error that says to run
    `peerbit-fs install-adapter --force`. Embedders that drive the server with
    their own client must present `server.token` in the offer (see
    `IPC_PROTOCOL_V2.md`, whose golden negotiation vector now carries a token).

    The adapter change reaches users through this CLI version's adapter release
    (`shared-fs-native-v<version>`), which the release publishes automatically.
    Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.

### Patch Changes

- 4eb1b5f: Make each native mount callback's IPC round trip cheaper. The native adapter
  now reads and writes its daemon connection with blocking system calls (except
  on Windows). A FUSE callback runs on a thread that cgo locks to it; while it
  waited in Go's network poller, each response woke another thread that then
  had to hand the wakeup over.

    On Linux, `peerbit-fs mount` now serves the adapter on a Unix socket in a new
    owner-only directory under `/tmp`, removed on exit, instead of TCP loopback. A
    round trip skips the TCP stack, and other local users can no longer connect to
    the daemon. macOS and Windows keep TCP loopback: macOS Unix sockets buffer
    only 8 KiB, which Node cannot raise, and made 128 KiB reads 1.7 times slower.

    The gains were measured on macOS only, from a C thread as FUSE calls the
    adapter, in four runs of 5,000 getattr-shaped round trips per transport. Over
    TCP loopback, blocking calls took 32.3 µs instead of 40.7 µs at the median,
    and 470 ms instead of 624 ms per 5,000 calls on average. The Linux
    configuration, a Unix socket with blocking calls, took 22.5 µs and 379 ms
    there. Linux itself has not been measured yet.

    `createSharedFsIpcServer` without an endpoint uses the same transport, and
    `defaultSharedFsIpcEndpoint` is removed. On macOS the default therefore moves
    from a Unix socket under `/tmp`, which other users could not connect to, to
    TCP loopback, which they can.

    The adapter change reaches users through this CLI version's adapter release
    (`shared-fs-native-v<version>`), which the release publishes automatically.
    Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.

- Updated dependencies [4eb1b5f]
- Updated dependencies [3f34885]
    - @peerbit/shared-fs@0.16.0

## 0.15.0

### Minor Changes

- a3fd415: Let a peer that opens a never-written filesystem by address become
  write-ready. Readiness needs positive evidence that log sync started, and
  until now only replicated namespace metadata (or a snapshot found by
  discovery) counted. A filesystem nobody has written has no metadata, so a
  joiner of a freshly created one stayed read-only, and
  `peerbit-fs mount <address>` failed after 120 s with "did not establish a
  safe initial write view".

    Two behaviour changes make this a minor release. A program loaded from an
    address through the Program API is now write-gated like any address open,
    and a creating open ignores `bootstrap` options, including
    `mode: "require"`.
    - Creating a filesystem now publishes a signed zero-document genesis
      manifest when the creator is a trusted full replica and automatic
      snapshots are enabled, before the creating open returns. A creating open
      no longer runs a cold-start bootstrap: a new filesystem has nothing to
      bootstrap from. `peerbit-fs create` no longer publishes its own; the
      library does it for every creator, and `create` now fails if the genesis
      is missing instead of printing an address nobody can join.
      `snapshot: { disabled: true }` skips it.
    - Only a program constructed locally creates. A program loaded from an
      address, whichever API opens it (`SharedFileSystem.open(address, ...)`,
      `peer.open(address)`), is now an address open like `openSharedFs` with an
      address: it stays gated until it settles a remote view, and it never
      publishes a genesis. Before, it was write-ready at once as a "creator".
    - Until something is written, the author of a genesis puts that manifest
      again (a linked put) whenever a peer session subscribes to the filesystem,
      and when it reopens while peers are subscribed. A joiner whose first join
      ended before it was ready (Ctrl-C, a crash, a mount timeout) already holds
      the genesis, so without a new entry every retry stayed gated until someone
      wrote. A session subscribes even when it returns after a crash, for which
      shared-log may emit no `replicator:join`. Retrying needs the creator
      online. Each peer session adds one small entry while the filesystem stays
      never-written. Only the author of a zero-document manifest listens for
      sessions, and it stops once something is written; closing the filesystem
      also removes the listener.
    - The first real snapshot CUTs that chain. A zero-document manifest counts
      as no snapshot, so the publisher replaces it at its first check after
      something is written, as it would publish a missing manifest, instead of
      waiting for 50 changes or an hour. A peer that was offline across that
      snapshot can still bring older chain entries back as orphan log heads.
      They cost a little log space and change nothing else; removing them needs
      upstream log support. The entries are not CUT sooner: a peer that returns
      holding an entry an earlier CUT removed would put it back for good.
    - A replicated snapshot manifest now counts as readiness evidence, like
      replicated metadata. A gated joiner cannot publish one, so it came from
      another peer.
    - A zero-document manifest is no longer a bootstrap candidate. It installs
      nothing, and its overlay retired at once, counting as verified coverage
      and readiness evidence without covering any log entry, though a genesis
      can be older than the data. Such joiners now plain-join, where the
      manifest's replication is the evidence. A join with
      `bootstrap: { mode: "require" }` of a never-written filesystem fails and
      says that only zero-document manifests were found. Snapshots with
      documents are unchanged. This also stops a reopen of an empty filesystem
      from briefly rejecting `prepareForDisposal` while it "bootstrapped" from
      its own genesis.
    - `snapshotWrite` replaces the previous manifest with one put that CUTs its
      head, instead of a delete followed by a put. A joiner that never held the
      old manifest could keep the delete entry pending in its sync and never
      become write-ready. In a local repro this hit about half of the joins to
      any filesystem whose author had published twice.

    The rest of the gate is unchanged: a settled bootstrap, a connected
    replicator, an idle synchronizer and the quiet window. A joiner that reaches
    no replicator stays closed. There is no format change: the genesis is an
    ordinary bootstrap manifest and each re-publication an ordinary put.

    Known gap: the genesis proves only that sync with some replica started, and
    a replica vouches from its own view. One that missed writes while it was
    offline, such as a creator restarting after another machine wrote and left,
    still vouches that the filesystem is empty, so a joiner that reaches only
    that replica becomes write-ready on an empty view. Nothing is lost: the
    missed writes merge when a peer holding them comes back, and clashing paths
    become conflict copies. This is the same exposure as settling on any donor's
    partial view. Closing it needs a per-peer sync frontier from Peerbit
    upstream.

### Patch Changes

- 267dae5: Keep a peer that joins next to a replicator from missing it. A joiner used to
  learn which peers hold a filesystem from one Subscribe announcement, sent
  through the topic's shard overlay. When that announcement was lost, the joiner
  could be connected directly to a replicator and still see no subscriber, so
  `list` failed with "Path does not exist" until something else repaired
  discovery. CI hit this once: a cold join of a 500-file tree waited out its
  90 s budget, and the automatic retry passed in seconds.

    Opening a filesystem now asks each directly connected pubsub neighbour for
    the log topic's subscribers, and asks each new neighbour once its outbound
    stream is ready. The request is Peerbit's `requestSubscribers(topic, peer)`,
    sent over the neighbour's own stream, so it does not depend on the shard
    overlay. The neighbour answers directly, and shared-log's capability exchange
    then makes it ask back, so both sides learn each other.

    A local harness drops the joiner's overlay announcement on purpose. With it,
    17 of 50 joins without this change still saw no subscriber after 30 s.
    With this change, 0 of 50 stalled, and the joiner could read the tree 0.35 s
    (median) and at most 2.3 s after open started.

    This covers a subscriber that is a direct neighbour: the test topology and
    the usual `peerbit-fs mount <address> --peer <multiaddr>` join. A joiner that
    reaches the replicators only through a relay that does not subscribe is not
    helped, and the separate ~90 s open stall seen with several concurrent fresh
    joiners still needs an upstream fix.

- 92a0f01: Make path lookups on Linux mounts cheaper. cgofuse v1.6.0 cleared libfuse's
  configuration when a FUSE 3 mount started, so the kernel cached nothing and
  every `lstat` cost one adapter round trip per path component plus one. The
  native adapter now builds against a cgofuse fork without that line
  (`github.com/dao-xyz/cgofuse v1.6.0-peerbit.1`, until winfsp/cgofuse#110 is
  released) and mounts Linux with
  `-o entry_timeout=0.1,attr_timeout=0,negative_timeout=0`: the kernel caches
  which file a name leads to for at most 0.1 s, and never caches attributes or
  missing names. A stat of a two-component path repeated within 0.1 s of the
  path's last lookup costs one adapter callback instead of three; once the
  cached names expire, the next stat again costs one per path component plus
  one. On a GitHub Linux runner, `git status` of a 2,000-file tree fell from
  2.91 s to 1.23 s and `git clone` from 35.6 s to 27.0 s.

    Other peers' edits, deletes and renames still appear with no added delay.
    For up to 0.1 s after another peer changes a path's type (file, directory or
    symlink), calls that use the old cached name can fail. A stat fails once with
    `EIO` and the next call is correct (measured for a file replaced by a
    directory). Opening the name, following it as a link or walking a path
    through it can fail with `ENOTDIR`, `EISDIR` or `EINVAL` on every try until
    the cached name expires (not measured). On Linux the adapter's `Open` now
    answers `ESTALE` where the daemon reports a missing path, so the kernel
    retries with a fresh lookup and creating a file right after another peer
    deleted it succeeds. macOS and Windows are unchanged.

    The change is in the native adapter, so it reaches users through this CLI
    version's adapter release (`shared-fs-native-v<version>`), which the release
    publishes automatically. Installing the CLI fetches it; otherwise run
    `peerbit-fs install-adapter`.

- 3e95367: Stop sending per-entry stats with directory listings on Linux mounts. The
  native adapter asked the daemon for every entry's stats and enabled
  readdir-plus, but the high-level API of libfuse 3.16 and older (the versions
  the adapter loads) passes those stats to the kernel with node ID 0, which
  tells the kernel to ignore them: a `stat` of each listed file cost the same
  adapter callbacks with or without them. libfuse
  also kept a lookup reference for every listed entry that the kernel never
  released. Linux now requests compact listings, as macOS already did, and
  passes the kernel only each entry's type. A 128-file listing is 4.9 KB over
  IPC instead of 16.4 KB, and its round trip took 0.28 ms instead of 0.50 ms in
  a local measurement. Entries still report their type (`d_type`), so
  `readdir` with file types needs no extra `stat`. macOS listings now report
  each entry's type too, where they reported an unknown type before. Windows
  is unchanged: WinFsp uses the stats.

    The change is in the native adapter, so it reaches users through this CLI
    version's adapter release (`shared-fs-native-v<version>`), which the release
    publishes automatically. Installing the CLI fetches it; otherwise run
    `peerbit-fs install-adapter`.

- Updated dependencies [267dae5]
- Updated dependencies [a3fd415]
    - @peerbit/shared-fs@0.15.0

## 0.14.0

### Minor Changes

- daf9d6c: The native adapter stores the exec bit and mtime and supports symlinks through
  a mount. It needs the IPC ops of this release, so use the managed adapter
  pinned to it (`peerbit-fs install-adapter --force`).
    - `chmod` keeps only the exec bit, and is a no-op on Windows so an ACL edit
      cannot clear a POSIX peer's exec bit. `chown` succeeds without storing
      anything.
    - `utimens` sets mtime in milliseconds. `UTIME_NOW` (also macOS's -1) takes
      the adapter's clock, an omitted mtime (`touch -a`, also macOS's -2) changes
      nothing, and a time before 1970 or above 2^53-1 ms fails with `EINVAL`.
    - `open(O_CREAT)` and `mknod` pass the create mode, so a new file created
      `0755` is executable; Windows passes none.
    - `symlink` and `readlink`: a target that is not valid UTF-8 fails with
      `EINVAL`, and `readlink("/")` (WinFsp's symlink probe) answers `EINVAL`
      without IPC. Directory listings accept symlink entries.
    - `access(2)` with `X_OK` on a regular file without an exec bit fails with
      `EACCES` off Windows, so `test -x` agrees with `execve`.
    - Files and directories report the mounting user as owner off Windows instead
      of root, so git no longer reports dubious ownership.
    - Breaking: `peerbit-fs status` drops the synthetic `nativeMount.metadata`
      JSON contract and its printed `metadata ...` lines. The READMEs document the
      mount semantics instead.

- 2612110: The mount backend and its IPC protocol expose the exec bit, mtime and
  symlinks.
    - `getattr` and `readdir` stats report each file's stored mode (`0o100644` or
      `0o100755`) and mtime; atime and ctime equal mtime. A symlink has kind
      `"symlink"`, mode `S_IFLNK|0777` and its target's byte length. Entries
      without a mode, and conflict copies of any version (links included), are
      regular `0644` files. `/` and the conflict directories report one time
      captured when the backend is created instead of the current time.
    - New backend and IPC ops `setattr(path, { mode?, mtimeMs? })`,
      `symlink(target, path)` and `readlink(path)`, and `open` takes the create
      mode as a third argument. chmod keeps only the exec bit (any x bit gives
      `0o100755`); chmod and utimens of a directory, `/` or a symlink are no-ops,
      and modes outside `0..0o7777` fail with `EINVAL`. On a file with buffered
      writes, including a new `O_CREAT` file, `setattr` folds into the next
      commit, so git's lock-file chmod or `cp -p` mints one version; otherwise it
      calls the target's `setMetadata` and moves no bytes. `open` of a symlink
      fails with `EINVAL`, and `readlink` fails with `EIO` while the link's
      version is not readable locally.
    - A write or truncate sets mtime to its own time, and a dirty handle's stat
      equals the stat after its commit. A commit always sends the handle's mtime,
      so a `utimens` before close (`cp -p`) is kept even when it equals the stored
      time, and sends the mode only when it changed locally, so another peer's
      chmod survives a local edit.
    - `SharedFsMountBackendTarget` requires `setMetadata`, and `writeFile` results
      must carry `mode` and `mtime`; a commit fails with `EIO` otherwise.
    - Breaking: saving identical bytes through a mount is no longer a no-op. Any
      write, including `> file` and in-place editor saves, advances mtime and
      publishes one version that reuses the stored chunks, with one `modified`
      watch event and one `keepVersions` slot. A flush, fsync or close without a
      write still mints nothing.

- 7c74a2c: Store the exec bit and mtime on every file version, and add symlinks. This is
  a store break: the program variant is now `peerbit_shared_fs_v9_1` and new
  filesystems use the entries salt `/shared-fs/v9.1`, so filesystems created by
  earlier releases no longer open. Recreate them; shared-fs has no production
  users, so no migration path is kept.
    - `FileVersion` gains the required `mode` (`SHARED_FS_MODE.file`,
      `.executable` or `.symlink`: `0o100644`, `0o100755`, `0o120000`) and `mtime`
      (ms) fields, mirrored on index rows. Ingest rejects other modes, an mtime
      above `2^53 - 1`, and a symlink version whose size is outside 1-1023 bytes.
    - `WriteFileOptions.mode` and `mtime`. Without them a write keeps the
      best-ranked parent's mode, and its mtime only when the bytes are unchanged
      (otherwise the write time). `writeBatch` and naming restores keep the mode;
      `resolveConflict()` keeps the selected mode, and its mtime only for the
      visible bytes. Both no-op saves also require unchanged metadata, and a write
      of a current head's bytes with new metadata reuses its locally stored chunks
      without chunk IO (unless it sets `chunkSize` or `dedup: "off"`).
    - New `setMetadata(path, { mode?, mtime? }, { expectedNodeId? })` on
      `SharedFileSystem`, `SharedFsHandle` and `IgnoreAwareFs` (which rejects
      ignored paths with `EIGNORED`): one chunk-reusing version that merges every
      head with the same bytes.
    - A symlink is a file node written with `mode: SHARED_FS_MODE.symlink` whose
      bytes are its target (1-1023 bytes of UTF-8 without NUL; never followed).
      A node never changes between symlink and regular file, nor builds on a base
      version of the other type (`EINVAL`), and `writeBatch` and `setMetadata`
      reject symlinks.
    - A content conflict now needs heads with different bytes. Heads that differ
      only in mode or mtime are not a conflict: `conflicts()` lists one version
      per content and `SharedFsEntryInfo.conflict` follows it, while
      `headVersionIds` still lists every head. An explicit-base write also merges
      current heads that hold a base's bytes.
    - `SharedFsEntryInfo.mode`, and `updatedAt` is the visible version's mtime for
      files. `SharedFsVersionInfo.mode` and `mtime`, which the CLI's
      `conflicts --json` and `resolve-conflict --json` now print.

    Mounts expose these fields; see the mount backend changeset.

- 2126c15: Remove pre-release compatibility machinery. This is a breaking change made
  before 1.0; shared-fs has no production users, so no migration path is kept.

    Library API removals:
    - `SharedFileSystem.trustLegacyLocalReplica()` and
      `SharedFsHandle.trustLegacyLocalReplica()`, and the exported
      `TrustLegacyLocalReplicaOptions` type.
    - `BootstrapStatus.legacyPromotionEligible`.
    - The `"legacy-operator-assertion"` value of
      `BootstrapStatus.writeReadinessSource` and of the cold-join telemetry
      `write-ready` event `source`. Both are now `"creator" | "remote-settled"`.
    - `SharedFsVersionInfo.deleted` (deprecated and always `false`). It also
      disappears from `writeFile()`, `writeBatch().results`, `versions()`,
      `conflicts()` and `versionsByChangeset()` results. Deletion is reported by
      naming events.
    - The exported `FileHead` type and `isFileHead()` guard. Use `FileVersion` and
      `instanceof FileVersion`.

    CLI removals:
    - The `peerbit-fs trust-legacy-replica` command.
    - `filesystem.bootstrap.legacyPromotionEligible` in `status --json`, and the
      `legacy promotion eligible:` line in text `status`.
    - The `deleted` key in version objects printed by `conflicts --json`,
      `status --include-conflicts --json` and `resolve-conflict --json`.
    - The mount write-readiness timeout message no longer suggests
      `trust-legacy-replica`.

    Local readiness sidecar (`<directory>/shared-fs-bootstrap/<address>.json`):
    - New writes contain only `writeReady`, `writeReadySource` and `bootstrap`.
      The `openedBefore` and `legacyUnproven` keys are no longer written.
    - The reader ignores those keys, so an existing sidecar that still contains
      `openedBefore` or `legacyUnproven: false` stays valid, and its readiness
      proof is kept.
    - A sidecar whose `writeReadySource` is `"legacy-operator-assertion"` is now
      malformed. The store fails closed: it reopens gated (not write-ready, guard
      disarmed) until remote-settled readiness, with no data loss. Missing,
      unreadable and malformed sidecars are still fail-closed.
    - Downgrading to an older release after this change makes warm reopens gated,
      because older readers require `openedBefore`. That costs availability, not
      safety.

    Write-readiness donor check: a transport without the DirectStream route API
    (`routes.isReachable` and `routes.getBestRouteHint`) and the live `peers` map
    can no longer prove a donor, so readiness fails closed. The pinned Peerbit
    transports provide both, so current behavior is unchanged.

    There is no wire-format change.

- 673320d: Retire the in-process `fuse-native` mount fallback. The Go cgofuse adapter
  (`peerbit-shared-fs-native`, installed with `peerbit-fs install-adapter`) is
  now the only native mount path on Linux, macOS and Windows. `fuse-native` was
  never a declared dependency, and its callbacks implemented none of chmod,
  chown, utimens, symlink or readlink. shared-fs has no production users, so no
  replacement is kept.

    Removed from `@peerbit/shared-fs`:
    - `mountNativeSharedFs` and its `NativeMountOptions` and `NativeMountSession`
      types.
    - `sharedFsBackendErrno`, the errno mapping only that adapter used. The Go
      adapter maps error codes itself.
    - The `"fuse-native"` member of `SharedFsMountProfileSource`.

    Changed:
    - `NativeMountSupport.adapter` is `"fuse"` instead of `"fuse-native"` on Linux
      and macOS. `getNativeMountSupport` no longer probes for `fuse-native` and
      lists the `peerbit-shared-fs-native adapter binary` as missing when no
      adapter is found, as it already did on Windows.
    - `peerbit-fs mount` with no adapter now fails before opening Peerbit with an
      error that says to run `peerbit-fs install-adapter` (or to pass
      `--native-adapter` or set `PEERBIT_SHARED_FS_NATIVE_ADAPTER`) and lists the
      native mount requirements, instead of trying `fuse-native`.
      `peerbit-fs status` no longer lists `fuse-native` as an alternative, and
      `nativeMount.adapter` in `status --json` follows
      `NativeMountSupport.adapter`.

- ab2f1b9: Retire the shared-fs native IPC protocol v1 and pin the managed native adapter
  to the CLI's own release. This is a deliberate wire break between releases:
  old adapters and CLIs are refused, not supported.

    Wire break (IPC v1 retired):
    - The Node IPC server (`createSharedFsIpcServer`) speaks only negotiated binary
      IPC v2. It no longer serves base64 JSONL v1: an un-negotiated first operation
      is answered with an `EPROTONOSUPPORT` error that says to run
      `peerbit-fs install-adapter --force`, and the connection is closed without
      dispatching it. An offer is only accepted if it includes version 2, and v2 is
      always selected. Native adapters from 0.13.15 or earlier (v1 only) no longer
      work with this CLI: used through `--native-adapter`,
      `PEERBIT_SHARED_FS_NATIVE_ADAPTER`, or `PATH`, they still mount, but every
      operation fails.
    - The Go native adapter offers only `[2]` and fails closed when a server rejects
      or closes the negotiation. It no longer falls back to v1 or starts in v1
      under a tiny request limit, so it cannot serve a CLI from 0.13.15 or earlier.
      It now negotiates before mounting, so an incompatible server fails the mount
      at startup instead of returning EIO on every operation.
    - The IPC handshake line has its own fixed 64 KiB bound, independent of the
      server's `maxRequestFrameBytes`. The `ipc.service` profile records always
      report `protocol: "v2"`. The golden negotiation vector now offers `[2]`.

    Public API break: the v1-only `createSharedFsIpcClient` export is removed from
    `@peerbit/shared-fs`. It had no non-test caller; embedders that drove a mount
    backend over IPC need a v2 client (see `IPC_PROTOCOL_V2.md`).
    `getNativeMountSupport` accepts `{ externalAdapter }` so a caller that already
    resolved an adapter does not have to publish it through the environment.

    Adapter version pin:
    - `peerbit-fs install-adapter` (and the global-install postinstall, which runs
      it with `--if-needed`) installs into one directory per release,
      `~/.peerbit/shared-fs/bin/shared-fs-native-v<version>/`, and writes
      `peerbit-shared-fs-native.install.json` next to the binary, recording its
      release tag, target, and SHA-256. CLIs of different versions (for example
      under two Node versions) therefore keep their own adapters side by side.
      Adapters that CLI 0.13.18 or earlier installed directly in
      `~/.peerbit/shared-fs/bin` are no longer used and can be deleted. An
      existing adapter in the release directory is kept only when its record names
      that release and this platform and still matches the binary; a stale,
      modified, or unrecorded adapter is replaced. `--force` always reinstalls. A
      failed download or replacement leaves the previous adapter and its record in
      place.
    - Downloads give up after 30 seconds without data, and the postinstall
      auto-install gives up after two minutes, so a stalled connection no longer
      hangs `npm install -g`.
    - `peerbit-fs mount` refuses the managed adapter before opening Peerbit when
      its record is missing, names another release or platform, or no longer
      matches the binary. The error names the installed and required versions and
      says to run `peerbit-fs install-adapter --force`. `peerbit-fs status`
      resolves the adapter the same way and reports the mount as unavailable,
      with that reason under `missing`, when mount would refuse it.
    - An adapter chosen with `--native-adapter` or
      `PEERBIT_SHARED_FS_NATIVE_ADAPTER`, or found on `PATH`, is not checked and is
      the user's responsibility: an adapter from 0.13.15 or earlier (IPC v1 only)
      still mounts, but every operation fails.
    - The undocumented `PEERBIT_SHARED_FS_NATIVE_VERSION` environment variable and
      the standalone installer's `--version` flag are removed.
      `install-adapter --adapter-version` remains for release validation and now
      warns that mount uses only the CLI's own adapter release.

    Release note: this CLI requires the native adapter built from this change. The
    release script dispatches the `shared-fs-native-v<cli version>` adapter release
    when the CLI version is unpublished. Users upgrading from an earlier CLI must
    run `peerbit-fs install-adapter` if the postinstall did not already install
    this release's adapter.

### Patch Changes

- c1e3e70: Break the library `writeFile` behind each profiled mount commit into
  sequential sub-phases. With `--mount-profile` (or a backend `profile` sink),
  `node-daemon.ndjson` now also holds `writeFile.*` records: `prepare`,
  `resolvePath`, `readHeads`, `hash`, `loadBase`, `chunk`, `touchChunks` (W1
  dedup probes, witness queries and chunk puts, with counts, bytes and dedup
  skips), `guard`, `versionPut`, `cacheApply`, `verifyChunks` (W2),
  `resolveParent`, `namingPut` and `result`. They carry a `writeId` that joins
  them to their `mount.target.writeFile` record, lie inside it, and are
  contiguous, so they partition the call instead of adding to it. `versionPut`,
  `namingPut` and each chunk put time one whole `Documents.put`; signing, log
  append and indexing inside it are not separated. The summary script adds a
  "writeFile breakdown" table (per sub-phase p50/p95 per write and share of
  `writeFile` time).

    The request is a live function in the write options, so the backend passes it
    only to `SharedFsHandle` and the artifact-ignore wrapper while they keep their
    default `writeFile` delegation (a private opt-in). Every other target,
    including a third-party custom mount target, sees exactly the unprofiled
    options. The summary counts sub-phase
    gaps and incomplete chains (for example records dropped by a full profile
    writer) and keeps those writes out of its tables. Profiling stays off by
    default: an unprofiled write only checks that the internal option is absent and
    reads no clock.

- d2f9e69: Remove the mount backend's fallback path for custom mount targets that lack
  the verified read, guarded namespace and self-hashing write capabilities, and
  the `writeFileInput` commit-copy option. This is a breaking change made before
  1.0; shared-fs has no production users, so no migration path is kept. Wire and
  on-disk formats are unchanged. The CLI already used the remaining path.

    `SharedFsMountBackendTarget` changes:
    - `readVersionForMount`, `mutateNamespaceForMount` and `stat` are required.
      For files, `stat` must include `versionId`, `contentHash`, `size` and
      `headVersionIds` matching `readVersionForMount`.
      Mounts read file contents only through `readVersionForMount` (including
      `.peerbit-conflicts` version files), remove and rename only through
      `mutateNamespaceForMount`, and look paths up only through `stat`.
    - `readFile`, `readVersion`, `rm` and `rename` are no longer part of the
      target type; mounts never call them. A `SharedFsHandle` or
      `SharedFileSystem` subclass (or any delegating wrapper) that customizes
      read, remove or rename policy must apply it in `readVersionForMount` and
      `mutateNamespaceForMount` at the layer it overrides, as `IgnoreAwareFs`
      does. Overriding `rm`, `rename` or `readVersion` no longer switches a mount
      to a slower path that honours the override.
    - `writeFile` must resolve to `{ id, nodeId, contentHash, mountWriteOutcome }`.
      A `void` result or a missing or unknown `mountWriteOutcome` now fails the
      commit with `EIO`. Mounts always pass `noOpIfHeadVersionIds`, and the target
      must hash its input itself; the mount no longer hashes commits or opened
      bytes locally.
    - `writeFile` may retain its input `Uint8Array` indefinitely but must never
      mutate it or transfer/detach its `ArrayBuffer`. Mounts now always lend their
      exact-size handle buffer instead of copying it (an oversized buffer is still
      copied to its logical length).
    - A lost `O_CREAT|O_EXCL` commit race is always reported as `EEXIST` (custom
      targets previously got `EAGAIN`).

    Removed exports and methods:
    - `SHARED_FS_MOUNT_READ_SEMANTICS`, `SHARED_FS_MOUNT_WRITE_SEMANTICS` and
      `SHARED_FS_MOUNT_NAMESPACE_SEMANTICS`, and the `SharedFsMountReadSemantics`,
      `SharedFsMountWriteSemantics` and `SharedFsMountNamespaceSemantics` types.
      `SharedFsMountWriteOutcome` stays.
    - `SharedFileSystem.mountNamespaceSemantics()`,
      `SharedFsHandle.mountReadSemantics()`, `mountWriteSemantics()` and
      `mountNamespaceSemantics()`, and `IgnoreAwareFs.mountNamespaceSemantics()`.
    - The optional `mountReadSemantics`, `mountWriteSemantics` and
      `mountNamespaceSemantics` members of `SharedFsMountBackendTarget`.
    - `SharedFsMountBackendOptions.writeFileInput`.

- Updated dependencies [90768cc]
- Updated dependencies [2612110]
- Updated dependencies [7c74a2c]
- Updated dependencies [c1e3e70]
- Updated dependencies [d2f9e69]
- Updated dependencies [2126c15]
- Updated dependencies [673320d]
- Updated dependencies [ab2f1b9]
    - @peerbit/shared-fs@0.14.0

## 0.13.18

### Patch Changes

- cfa9c2f: Add opt-in mounted-path profiling. `peerbit-fs mount --mount-profile <dir>`
  writes `node-daemon.ndjson` (IPC backend service, one `mount.localCommit`
  record per flush/fsync/release/truncate fence, and the nested target
  `writeFile`) through a bounded asynchronous writer that drops and counts
  records instead of slowing the mount, and ends with a summary record. Records
  carry a schema version, Unix-nanosecond start anchors, failure codes, and the
  IPC request id and connection port needed to join them with the native
  adapter's records. The library exports `openSharedFsMountProfileFile` and
  `createSharedFsMountProfileWriter`. Profiling is off by default and adds only a
  sink check when disabled.

    The CLI asks the external adapter for `native-adapter.ndjson` through the
    `PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE` environment variable, so adapters built
    before this change ignore it and mount unprofiled. Native callback, IPC queue,
    and round-trip records require a native adapter release that includes this
    change.

- Updated dependencies [cfa9c2f]
- Updated dependencies [4a450e7]
    - @peerbit/shared-fs@0.13.17

## 0.13.17

### Patch Changes

- 475d60f: Compact emitted JavaScript whitespace while preserving declarations, source maps, module surfaces, and the CLI shebang.
- 31356ed: Preserve both disposal-preparation and shutdown failures when they occur together. Keep the original receipt evidence as the aggregate cause, retain shutdown failure details, and never print disposal success after either failure.
- 31356ed: Upgrade Shared FS to the coherent Peerbit persisted-readiness and cold-open
  cohort. Forward advisory SharedLog open/profile spans through the existing
  telemetry surface, migrate durability tests to the public exact-entry readiness
  waiter, and require caller-exclusive upstream block-store safety metadata in
  addition to the Shared FS ownership assertion before physical snapshot segment
  reclamation.
- Updated dependencies [475d60f]
- Updated dependencies [dbf5321]
- Updated dependencies [31356ed]
- Updated dependencies [dd79d42]
- Updated dependencies [a7eb210]
- Updated dependencies [630ac12]
- Updated dependencies [e30a8d4]
- Updated dependencies [fde5d3f]
- Updated dependencies [31356ed]
- Updated dependencies [31356ed]
- Updated dependencies [31356ed]
- Updated dependencies [c26a600]
- Updated dependencies [a05b7c1]
- Updated dependencies [a7279fb]
- Updated dependencies [31356ed]
    - @peerbit/shared-fs@0.13.16

## 0.13.16

### Patch Changes

- ac1ed98: Optionally include snapshot-consistent stat metadata in Shared FS directory
  entries and publish native adapter binaries that request it only when cgofuse
  can use readdir-plus on Linux FUSE 3 or WinFsp, avoiding per-entry IPC lookups
  without bloating compact listings on other mounts.
- 2ca5ab1: Report the mounting account as the synthetic WinFsp owner so Windows
  replacement writes, including Node open with truncation, receive the extended
  attribute access required by CreateFileW.
- 19e001f: Negotiate binary IPC v2 with the native Go adapter so read and write payloads use bounded raw frame bodies while preserving JSONL v1 compatibility and fail-closed no-replay semantics. Publish matching rebuilt native adapter binaries with the CLI patch.
- Updated dependencies [ac1ed98]
- Updated dependencies [19e001f]
    - @peerbit/shared-fs@0.13.15

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
