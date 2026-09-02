# Peerbit Shared FS Native Adapter

Experimental native mount adapter for `@peerbit/shared-fs`.

This adapter speaks the shared-fs JSON-lines IPC protocol and mounts the
filesystem through [cgofuse](https://github.com/winfsp/cgofuse), which supports:

- Linux: FUSE/libfuse
- macOS: macFUSE
- Windows: WinFsp

Normal CLI users should install a prebuilt adapter:

```bash
peerbit-fs install-adapter
```

That command downloads the matching release asset into
`~/.peerbit/shared-fs/bin`; `peerbit-fs mount` auto-detects it.

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
Windows. The adapter keeps one serialized connection open for the mount
session, matching cgofuse's current single-threaded mode. A transport failure
fails the current filesystem operation and discards that connection; the next
explicit operation reconnects. Requests are never replayed automatically
because a lost response does not prove that a mutation was not applied.

The portable IPC microbenchmark exercises the real Go client without requiring
FUSE or Peerbit networking:

```bash
go test -run '^$' -bench '^BenchmarkIPCClientRoundTrip$' -benchmem -count=5
```

It reports metadata latency, 4 KiB through 1 MiB read/write throughput,
allocations, and connections per operation. Its Go echo peer mirrors the
JSON/base64 framing so the result isolates Go-client transport and framing
costs; it does not include the Node daemon, FUSE, or Peerbit replication.

## POSIX metadata limits

The shared model currently persists names and file content, not POSIX mode,
ownership, or explicitly assigned timestamps. Native stat results therefore
use synthetic fixed modes: directories are `0755` and files are `0644` on
Linux and macOS; WinFsp normalizes those to `0777` and `0666`. Modes passed to
create, mknod, and mkdir are not persisted.

The external adapter rejects chmod, chown, and explicit timestamp updates with
`ENOSYS` instead of falsely reporting that unrepresented state was saved. The
optional in-process adapter does not implement these mutations either.
Ownership is adapter-synthetic and is not a replicated permission boundary.
The external adapter's access callback checks path existence but does not
enforce its requested read/write/execute mask, so `access(2)` and tools such as
`test -w` are advisory. Mount mode and owner fields are not an authorization
boundary; use Shared FS trusted-writer authorization for write access.

Reported mtime/ctime values are logical or synthetic filesystem times, not
user-settable POSIX metadata. File mtime normally follows the visible content
version, while directory mtime follows its naming event rather than child
changes. Reported atime mirrors mtime and is not persisted separately.
`peerbit-fs status --json` exposes these limits under
`nativeMount.metadata`.

## Why Go?

The Peerbit filesystem logic remains TypeScript. Go is only used for the thin
native mount process because cgofuse already provides one adapter surface across
Linux FUSE, macFUSE, and WinFsp. That keeps the privileged/platform-specific
mount layer small, gives us one IPC bridge for all three operating systems, and
lets releases ship a single adapter binary per platform without Node native
addon ABI coupling. The JSON-lines IPC boundary is intentionally narrow, so the
adapter could be replaced later without changing the Peerbit storage model.

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
