# Peerbit Shared FS CLI

Experimental native mount CLI for `@peerbit/shared-fs`.

```bash
peerbit-fs create --auth
peerbit-fs whoami
peerbit-fs trust <address> <public-key>
peerbit-fs mount <address> <mountpoint>
peerbit-fs mount <address> <mountpoint> --native-adapter peerbit-shared-fs-native
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs benchmark [address]
peerbit-fs unmount <mountpoint>
```

`benchmark` writes and reads one large file plus a configurable many-small-files
workload. It is a baseline for tracking regressions, not a claim that v0 is
optimized for code workspaces.

`status` prints the current native mount adapter, whether its prerequisites are
available on the host, and any missing pieces before optionally opening an
address.

`create --auth` creates an access-controlled filesystem rooted at the local
Peerbit identity. Another machine can run `peerbit-fs whoami` to print its
writer key; the owner can then run `peerbit-fs trust <address> <public-key>` to
authorize that writer.

Linux/macOS mounts require FUSE/macFUSE plus the optional `fuse-native` package.
The external `packages/shared-fs/native` adapter uses cgofuse for Linux FUSE,
macFUSE, and WinFsp, and can be selected with `--native-adapter` or the
`PEERBIT_SHARED_FS_NATIVE_ADAPTER` environment variable. The repo includes a
manual `Shared FS Native Smoke` GitHub workflow for Linux FUSE. Portable CI
still runs the backend and cross-OS shared-store checks on Linux, macOS, and
Windows.
