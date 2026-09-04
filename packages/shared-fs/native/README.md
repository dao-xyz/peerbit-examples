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

On Windows, the adapter reports the mounting account as the synthetic owner.
Shared FS does not persist portable uid/gid metadata, and WinFsp otherwise
maps the missing owner to uid/gid 0. Selecting the mounting account preserves
normal replacement writes such as Node `open("w")`, whose Windows access mask
includes extended-attribute writes. Peerbit writer authorization remains the
authority for filesystem mutations; this mount option does not broaden it.

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

To isolate retained-connection concurrency on one host, hold the eight-item
workload constant while sweeping one, two, four, and eight adapter lanes:

```bash
pnpm shared-fs:benchmark:node-go-ipc -- \
  --adapter-widths 1,2,4,8 \
  --parallelism 8 \
  --samples 100 \
  --output node-go-ipc-width-sweep.json
```

It compiles the real Go `ipcClient`, starts the real Node
`createSharedFsIpcServer` on a fresh TCP loopback port, performs untimed
warmups, and emits raw monotonic wall-clock batch samples plus p50/p95 summaries
for `getattr` and 4 KiB and 1 MiB reads/writes. Widths execute sequentially in
the requested order against the same Node process and host. Every retained lane
negotiates binary v2 before any warmup or sample. Work item `i` uses lane
`i % adapterWidth`, so widths below the explicit workload parallelism preserve
per-connection serialization while allowing concurrency across lanes.

The backend is deterministic, immediate, and in-memory. Concurrent work uses
distinct logical paths and handles, with handle-specific payloads. Full result
and read-byte validation happens outside the timer; each write is subsequently
verified and cleared through its own handle so concurrent writes cannot share a
racy global verification slot. Summaries report aggregate items/s for the whole
batch and aggregate logical MiB/s for data operations. Allocation deltas cover
only the timed Go client batch. The JSON also records both concurrency axes,
the package version, lockfile SHA-256, Git HEAD when resolvable, host runtime
details, raw samples, and a hash plus path list for the exact benchmark inputs
(including dirty worktree content) so comparisons remain attributable. The
harness recomputes that provenance after the run and validates the complete
final report before returning, printing, or saving it.

This is a reusable negotiated binary-v2 transport baseline, not filesystem
performance. It excludes FUSE/macFUSE/WinFsp, mount syscalls, Peerbit,
replication, storage, persistence, and durable acknowledgements. It has no
pass/fail performance threshold. Use `--warmups`, `--samples`, and
`--timeout-ms` to tune a bounded manual run. Adapter widths are unique integers
from 1 through 16; workload parallelism is from 1 through 64 and must be at
least the largest width. Omit `--output` to print JSON only.

### Mounted filesystem benchmark

The next report tier uses normal Node filesystem APIs against a path that is
already mounted:

```bash
pnpm shared-fs:benchmark:native-mount -- \
  --mount /path/to/mount \
  --samples 30 \
  --warmups 3 \
  --output native-mount.json
```

It records raw monotonic samples and p50/p95 summaries for metadata, 4 KiB and
1 MiB sequential reads and writes, sequential 1 KiB small-file creation,
directory listing, and a 4 KiB in-place overwrite of a configurable base file.
Every timed write uses `open`, complete positional writes, `fsync`, then
`close`; the report preserves those phase timings. Deterministic contents are
fully read and checked after each timer. The recorded `counter-mix32-v1` corpus
uses a fixed seed and produces distinct 512 KiB regions so content-addressed
chunk deduplication does not turn ordinary binary cases into duplicate-block
microbenchmarks. `--overwrite-base-bytes`,
`--small-files`, and `--readdir-entries` have conservative bounded ranges.

These are warm, default-platform-cache timings. The harness neither evicts
kernel/application caches nor requests direct I/O, and it does not instrument
adapter callback counts; a cached read or metadata lookup might not reach a
userspace mount callback. Runs are sequential (`concurrency: 1`) and therefore
do not measure the adapter's global request-serialization ceiling.

The harness creates and normally removes one unique child below the supplied
path. Its workload timeout is cooperative between filesystem operations. The
standalone command also has a hard wall-clock deadline of that timeout plus five
seconds; it starts before provenance hashing and includes owned-directory
cleanup, report publication, and stdout flushing. A syscall that stalls until
that deadline causes exit status 124, and cleanup is only best-effort. Reports
are written through an adjacent temporary file and atomically renamed. The
harness hashes itself, the lockfile, and each repeated `--implementation-input`
file or directory before and after the run. Directory inputs are traversed
recursively while `.git` and `node_modules` are excluded, allowing callers to
fingerprint built runtime trees without hashing dependency stores.

The real-mount wrappers also record the adapter build tags, exact `go version`
output, and the detected fuse3, macFUSE, or WinFsp runtime version as bounded
implementation details. A value is recorded as `unknown` when a host cannot
determine it; the harness does not synthesize a version.

The target and its repeated `--mount-option` values are caller-supplied and are
not independently proven by the harness. Successful local `fsync` completion
does not prove parent-directory crash durability, remote Peerbit replication,
or persisted delivery.

The external native smoke scripts collect this report while their real mount
is active when `PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OUTPUT` names an output
file. When `PEERBIT_SHARED_FS_NATIVE_CONTROL_BENCH_OUTPUT` is also set, the
wrapper runs the identical workload against the runner's local temporary
filesystem and records it as a separately labelled control. Adapter and mount
details in that control identify its paired Shared FS comparison and are
explicitly marked as outside the timed control path. The reports do not
calculate or gate on performance ratios.

Those real-mount and control runs default to 30 measured samples, three
warmups, a ten-minute cooperative workload timeout, and a ten-minute-plus-five-
second hard command deadline. The
`PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_SAMPLES`,
`PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_WARMUPS`, and
`PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_TIMEOUT_MS` environment variables can
select other harness-validated values. The integration is opt-in and has no
performance threshold. The Linux native smoke workflow can collect its FUSE
report and same-runner control directly; the native-OS workflow can collect
paired macFUSE and WinFsp reports from its real provisioned mounts.

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
