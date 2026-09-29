---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

The mount backend and its IPC protocol expose the exec bit, mtime and
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
