# Peerbit Shared FS CLI

Experimental native mount CLI for `@peerbit/shared-fs`.

```bash
peerbit-fs create
peerbit-fs mount <address> <mountpoint>
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs benchmark [address]
peerbit-fs unmount <mountpoint>
```

`benchmark` writes and reads one large file plus a configurable many-small-files
workload. It is a baseline for tracking regressions, not a claim that v0 is
optimized for code workspaces.

Linux/macOS mounts require FUSE/macFUSE plus the optional `fuse-native` package.
Windows requires a WinFsp adapter binary; the shared IPC/backend contract is in
place, but no WinFsp binary is bundled yet.
