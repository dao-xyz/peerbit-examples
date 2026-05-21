# Peerbit Shared FS CLI

Experimental native mount CLI for `@peerbit/shared-fs`.

```bash
peerbit-fs create
peerbit-fs mount <address> <mountpoint>
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs unmount <mountpoint>
```

Linux/macOS mounts require FUSE/macFUSE plus the optional `fuse-native` package.
Windows requires a WinFsp adapter binary; the shared IPC/backend contract is in
place, but no WinFsp binary is bundled yet.
