---
"@peerbit/shared-fs-cli": minor
---

The native adapter stores the exec bit and mtime and supports symlinks through
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
