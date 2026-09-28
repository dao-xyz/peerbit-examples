---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Retire the in-process `fuse-native` mount fallback. The Go cgofuse adapter
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
  `--native-adapter` or set `PEERBIT_SHARED_FS_NATIVE_ADAPTER`), instead of
  trying `fuse-native`. `peerbit-fs status` no longer lists `fuse-native` as
  an alternative, and `nativeMount.adapter` in `status --json` follows
  `NativeMountSupport.adapter`.
