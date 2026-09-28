---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": patch
---

Remove the mount backend's fallback path for custom mount targets that lack
the verified read, guarded namespace and self-hashing write capabilities, and
the `writeFileInput` commit-copy option. This is a breaking change made before
1.0; shared-fs has no production users, so no migration path is kept. Wire and
on-disk formats are unchanged. The CLI already used the remaining path.

`SharedFsMountBackendTarget` changes:

- `readVersionForMount`, `mutateNamespaceForMount` and `stat` are required.
  Mounts read file contents only through `readVersionForMount` (including
  `.peerbit-conflicts` version files), remove and rename only through
  `mutateNamespaceForMount`, and look paths up only through `stat`.
- `readFile`, `readVersion`, `rm` and `rename` are no longer part of the
  target type; mounts never call them. A `SharedFsHandle` subclass that
  customizes read, remove or rename policy must apply it in
  `readVersionForMount` and `mutateNamespaceForMount` too, as `IgnoreAwareFs`
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
  copied to its logical length). This also applies to targets passed to
  `mountNativeSharedFs`.
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
