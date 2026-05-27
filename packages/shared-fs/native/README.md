# Peerbit Shared FS Native Adapter

Experimental native mount adapter for `@peerbit/shared-fs`.

This adapter speaks the shared-fs JSON-lines IPC protocol and mounts the
filesystem through [cgofuse](https://github.com/winfsp/cgofuse), which supports:

- Linux: FUSE/libfuse
- macOS: macFUSE
- Windows: WinFsp

Build a native adapter binary with:

```bash
go build -tags native_mount -o peerbit-shared-fs-native .
```

On Linux with FUSE3 headers, use:

```bash
go build -tags "native_mount fuse3" -o peerbit-shared-fs-native .
```

The adapter is normally launched by `peerbit-fs mount --native-adapter`, but can
also be run directly:

```bash
peerbit-shared-fs-native --endpoint tcp://127.0.0.1:12345 --mountpoint /mnt/shared
```

The endpoint is provided by the TypeScript Peerbit daemon. TCP loopback is used
for external adapters so the same IPC transport works on Linux, macOS, and
Windows.

On macOS, from the repository root, the easiest experimental setup is:

```bash
pnpm shared-fs:install:macos
export PATH="$HOME/.local/bin:$PATH"
peerbit-fs status
```

This builds the TypeScript CLI and this adapter, installs wrappers in
`~/.local/bin`, and configures the wrapper to launch the external adapter.

See [ci.md](./ci.md) for the optional Scaleway-backed macOS/Windows native
mount CI setup.
