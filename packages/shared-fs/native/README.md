# Peerbit Shared FS Native Adapter

Experimental native mount adapter for `@peerbit/shared-fs`.

This adapter speaks the negotiated shared-fs IPC protocol and mounts the
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
The adapter negotiates binary protocol v2 on a fresh connection. Read and
write payloads then travel as raw frame bodies instead of base64 JSON, while
metadata plus body remain bounded to 64 MiB by default. If an older server
rejects or closes during the non-mutating negotiation, the adapter reconnects
once and uses JSONL v1. It never retries a filesystem operation. A server may
select v1 on the original connection, and very small configured request bounds
that cannot hold negotiation also remain on v1.

Directory responses may add a compact `stat` object to each entry. It omits
path and kind because the parent request, name, and entry kind already carry
them. This keeps representative short-name and maximum-length unescaped
100,000-entry listings below the 64 MiB response limit. Pathological names
that expand heavily under JSON escaping can still exceed the fixed bound and
need future paginated or binary directory framing. The Go adapter reconstructs
and validates the complete stat before passing it to cgofuse; missing or
malformed metadata lets the native host use its ordinary lookup/`getattr`
fallback, so older servers remain compatible. cgofuse enables the actual
readdir-plus capability on Linux with FUSE 3 when the kernel advertises it, and
on Windows through WinFsp. Only those builds request rich entries. macOS and
Linux FUSE 2 request the legacy compact entries because cgofuse cannot consume
readdir-plus metadata there. The options argument and response field are both
additive: old adapters receive compact entries from new servers, while a new
adapter accepts a compact response from an old server.

The portable IPC microbenchmark exercises the real Go client without requiring
FUSE or Peerbit networking:

```bash
go test -run '^$' -bench '^BenchmarkIPCClientRoundTrip$' -benchmem -count=5
```

It reports metadata latency, 4 KiB through 1 MiB read/write throughput,
allocations, and connections per operation. Its Go echo peer mirrors the
negotiated binary/raw-body framing so the result isolates Go-client transport
and framing costs; it does not include the Node daemon, FUSE, or Peerbit
replication.

To measure the complete current Node-Go boundary instead of the Go echo peer,
run this report-only benchmark from the repository root:

```bash
pnpm shared-fs:benchmark:node-go-ipc -- --samples 30 --output node-go-ipc.json
```

It compiles the real Go `ipcClient`, starts the real Node
`createSharedFsIpcServer` on a fresh TCP loopback port, performs untimed
warmups, and emits raw monotonic samples plus summaries for `getattr` and 4 KiB
and 1 MiB reads/writes. The backend is deterministic, immediate, and in-memory;
full result and byte validation happens outside the measured request. Reported
allocation deltas cover only the Go client process. Logical MiB/s is based on
the logical file-byte count. The JSON also records the package version,
lockfile SHA-256, Git HEAD when resolvable, host runtime details, and a hash
plus path list for the exact benchmark inputs (including dirty worktree
content) so comparisons remain attributable.

This is a reusable negotiated binary-v2 transport baseline, not filesystem
performance. It excludes FUSE/macFUSE/WinFsp, mount syscalls, Peerbit,
replication, storage, persistence, and durable acknowledgements. It has no
pass/fail performance threshold. Use `--warmups`, `--samples`, and
`--timeout-ms` to tune a bounded manual run; omit `--output` to print JSON only.

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
addon ABI coupling. The negotiated IPC boundary is intentionally narrow, so the
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
