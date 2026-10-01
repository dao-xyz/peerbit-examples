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

That command downloads the release asset matching the CLI version into
`~/.peerbit/shared-fs/bin/shared-fs-native-v<cli version>/` and records that
release, target, and the binary's SHA-256 in
`peerbit-shared-fs-native.install.json` next to it. `peerbit-fs mount`
auto-detects the managed adapter and refuses it, naming both versions, when
the record is missing, names another release or target, or no longer matches
the binary. Only the adapter from the CLI's own release is supported; run
`peerbit-fs install-adapter --force` to replace any other. An adapter passed
with `--native-adapter` or `PEERBIT_SHARED_FS_NATIVE_ADAPTER` is not checked:
an adapter from before IPC authentication does not present the daemon's token
and fails at mount startup, and one from 0.13.15 or earlier (IPC v1 only)
still mounts, but the CLI rejects every operation it sends.

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
PEERBIT_SHARED_FS_IPC_TOKEN=<token> peerbit-shared-fs-native --endpoint tcp://127.0.0.1:12345 --mountpoint /mnt/shared
```

The daemon (`createSharedFsIpcServer`) provides the endpoint and a token, a
random secret. The adapter presents the token when it negotiates each
connection, and the daemon closes a connection without it before running any
operation, on every platform. `peerbit-fs mount` passes the token in the
adapter's environment, which only the same user can read, never in its
arguments, which other local users can list; the adapter unsets it, so no
process it starts inherits it.

The endpoint is provided by the TypeScript Peerbit daemon: on Linux a Unix
socket in a new owner-only directory, which other local users cannot reach and
which skips the TCP stack; on macOS and Windows TCP loopback (macOS Unix
sockets buffer only 8 KiB, which made 128 KiB reads 1.7 times slower). The
adapter reads and writes with blocking system calls (except on Windows), so a
response wakes the FUSE callback's own thread instead of a Go poller thread
that must hand the wakeup over; that cut a getattr round trip by a fifth on
macOS. The adapter keeps one serialized connection open for the mount
session, matching cgofuse's current single-threaded mode. A transport failure
fails the current filesystem operation and discards that connection; the next
explicit operation reconnects. Requests are never replayed automatically
because a lost response does not prove that a mutation was not applied.
The adapter negotiates binary protocol v2 before it mounts, so an
incompatible server fails the mount at startup instead of every later
operation. Read and write payloads travel as raw frame bodies, while metadata
plus body remain bounded to 64 MiB by default. IPC v1 is retired: if the
server rejects or closes during the non-mutating negotiation (as a CLI from
0.13.15 or earlier does), the adapter reports the failure and never falls back
or retries a filesystem operation. Adapters from 0.13.15 or earlier speak only
v1 and are refused by current servers.

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
need future paginated or binary directory framing. Only the Windows adapter
requests these stats (`includeStats`) and enables readdir-plus, because WinFsp
consumes them. It reconstructs and validates each complete stat before passing
it to cgofuse; missing or malformed metadata lets WinFsp use its ordinary
`getattr` fallback. Linux and macOS request compact entries and pass the host
only each entry's type, for `d_type`: macOS (FUSE 2) has no readdir-plus, and
the high-level API of libfuse3.so.3 (3.16 and older), which cgofuse loads,
replays a listing with node ID 0, so the Linux kernel would discard the stats.
libfuse3.so.4 (3.17.1+) looks the entries up; revisit this if cgofuse loads
it. The `includeStats` option is optional per request: without it, and for a
backend that does not supply stats, the server returns compact entries.

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
`createSharedFsIpcServer` on the endpoint the CLI mounts with, performs untimed
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
directory listing, and a 4 KiB in-place overwrite of each configurable base
file. Every timed write uses `open`, complete positional writes, `fsync`, then
`close`; the report preserves those phase timings. Deterministic contents are
fully read and checked after each timer, except that an overwrite checks only
the 4 KiB it wrote and the whole base once after its last sample. Overwrite
offsets are 4 KiB aligned and pseudo-random across the whole base, from a fixed
seed per sample index; the report records the seed and how many 512 KiB leaves
the measured samples touched. The recorded `counter-mix32-v1` corpus uses a
fixed seed and produces distinct 512 KiB regions so content-addressed chunk
deduplication does not turn ordinary binary cases into duplicate-block
microbenchmarks. `--overwrite-base-bytes` takes a comma-separated list, for
example `4194304,33554432`; it, `--small-files`, and `--readdir-entries` have
conservative bounded ranges.

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
harness hashes itself, its developer-workload module, the lockfile, and each
repeated `--implementation-input` file or directory before and after the run.
Directory inputs are traversed recursively while `.git` and `node_modules` are
excluded, allowing callers to fingerprint built runtime trees without hashing
dependency stores.

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
performance threshold. The native smoke workflow can collect Linux FUSE and
Windows WinFsp reports, each with a same-runner control, on GitHub-hosted
runners; the native-OS workflow can collect a paired macFUSE report from its
Scaleway Mac. Hosted-runner numbers are not comparable with the Scaleway Mac's.

The mounted-benchmark report (schema version 5) also records each sample's
`startedAtUnixNs`/`endedAtUnixNs` window and keeps warmups in a separate
`warmupSamples` list flagged `warmup: true`, so mount profile records can be
attributed to exact samples. `PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_OVERWRITE_BASE_BYTES`
selects the in-place overwrite base sizes in the smoke wrappers.

`--dev-workload` (`PEERBIT_SHARED_FS_NATIVE_MOUNT_BENCH_DEV_WORKLOAD=1` in the
smoke wrappers, or the Linux smoke workflow's `dev_workload` input) adds
report-only developer-machine scenarios to both reports; the wrappers then
default to a 30-minute workload timeout. Nothing is downloaded.

- `edit-save-20480`: an editor-style atomic save (temporary file, `fsync`,
  rename over the original).
- `jsonl-append-1024-at-4194304` and `-at-33947648`: `fsync`'d 1 KiB appends
  to a 4 MiB log and to a 32 MiB + 384 KiB log, whose appends start mid-leaf
  for 512 KiB and 256 KiB leaves alike.
- `sqlite-insert-txn-in-<largest overwrite base>`: one-row `node:sqlite`
  transactions in a database of the largest overwrite base size.
- `git-clone-checkout-2000` and `git-status-2000`: `git clone --no-local` of a
  pinned synthetic 2,000-file tree from a local `git fast-import` origin, then
  `git status --porcelain` after ten untimed edits, once the index is settled.

Git scenarios take at most three samples after one warmup. A failed operation
is listed in `devWorkload.notMeasured` with its reason instead of failing the
run.

### Live callback and IPC profiling

`peerbit-fs mount --mount-profile <dir>` asks the adapter to write
`<dir>/native-adapter.ndjson` by setting
`PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE` in the adapter's environment. The
adapter never receives a new command-line flag, so an adapter built before
profiling existed ignores the variable and still mounts; only adapter builds
that contain this change write the file. An existing file is never truncated
or appended to: the adapter reports why on stderr and runs unprofiled.

Records use schema `peerbit.shared-fs.mount-profile` version 1 with a decimal
`startUnixNs` string and a monotonic `durationNs`:

- `native.callback` spans cgofuse callback entry through return. Read and
  write callbacks carry the requested `bytes` and `offset`; failures carry the
  negative FUSE `errno` and its portable `code` name (for example `ENOENT`,
  or `ESTALE` for a Linux open of a name another peer just removed).
- `ipc.queue` is the wait for the adapter's serialized request lane.
- `ipc.roundTrip` covers connection setup when needed (`connected: true`),
  framing, loopback, the Node service, and response decode. Failures carry the
  daemon's `code`, or `EIO` with `transport: true` when the daemon never
  answered.
- Queue and round-trip records carry `requestId` and, over TCP, the
  `localPort`, which equal the daemon's `requestId` and `remotePort`.

Emitting never blocks a callback. Records are copied into a bounded queue after
the request lane is released and written by one background goroutine; when the
queue is full a record is dropped and counted. On clean shutdown the adapter
writes a `profile.summary` record with `emitted`, `written`, `dropped`, and
`writeErrors`; while profiling, a follow-up SIGINT/SIGTERM after unmount does
not interrupt that bounded (at most 5 s) flush. A forced kill (for example the Windows smoke teardown) leaves
no summary, which the summarizer reports as an incomplete session. With
profiling off the only added work is a nil check.

Kernel time before callback entry, cached operations that never enter
userspace, and time after callback return are not observable here.

## POSIX metadata

Shared FS stores a git tree mode (`0644`, `0755` or symlink) and a millisecond
mtime on every file version. The adapter maps the POSIX calls onto them:

- `chmod` keeps only the exec bit: any x bit gives `0755`, otherwise `0644`.
  On a directory, `/` or a symlink it succeeds and stores nothing. `chown`
  always succeeds and stores nothing; files report the mounting user as owner
  (on Windows through `-o uid=-1,gid=-1`), so git does not report dubious
  ownership.
- The create mode of `open(O_CREAT)` and `mknod` keeps its exec bit.
- `utimens` sets mtime, floored to the millisecond, and ignores atime. atime
  and ctime report mtime. `UTIME_NOW` takes the adapter's clock, an omitted
  mtime (`touch -a`) changes nothing, and a time before 1970 or above 2^53-1 ms
  fails with `EINVAL`. A write sets mtime to its own time, even when it writes
  identical bytes.
- Directory mtime and ctime are change stamps kept by each mount, not stored
  times. They change when a name in the directory appears, disappears or is
  renamed, through this mount or from another peer, and when the directory
  itself moves. They do not change when a file in it is written, chmodded or
  touched, or when something changes deeper in the tree. A directory shows the
  time this mount first read it or last saw its names change, not its creation
  time. A mount's times start in the second after it starts, past those of a
  mount that stopped at least a second earlier, so git's untracked cache
  rescans once after each remount. A changed directory's time moves to the
  next whole second when that is at most 1 s ahead of the clock, so tools that
  compare whole seconds still see a change in the second they read. If the
  directory changes again within that second after a tool read it, its time
  stays in that second (1 ms later); git still rescans it while its index is
  no newer than that second. A time never runs more than 1 s ahead of the
  clock: a change that would need more keeps the time a tool read until the
  clock moves on, and the next stat after that shows it. Some events move a
  directory's time without changing its names, such as garbage collection of
  history this mount never read or a bootstrap view switch, and
  `.peerbit-conflicts` moves with every name change, since one can reveal or
  hide a conflicted file; tools then rescan once. `utimens` on a directory
  succeeds and changes nothing.
- git's `core.untrackedCache` is safe for a `.git` that one peer uses. For a
  `.git` that several peers use, set it to `false` explicitly, not `keep`:
  directory times and inode numbers are per mount, so one peer's cache must not
  be reused on another.
- `symlink` stores the target as given, never following or resolving it:
  1-1023 bytes of UTF-8 without NUL, otherwise `EINVAL`. 1023 bytes is the
  longest target every host's readlink buffer returns untruncated, so Linux
  targets of 1024-4095 bytes are refused. `readlink` fails with `EIO` while the
  link's version is not stored locally. Hard links stay `ENOSYS`.
- `access(2)` checks that the path exists and, off Windows, that `X_OK` on a
  regular file finds an exec bit, so `test -x` agrees with `execve`. It does
  not check read or write masks. Modes and owners are not an authorization
  boundary; use Shared FS trusted-writer authorization for write access.

Per platform:

- Linux (FUSE 3) supports all of it. The mount runs without
  `default_permissions`, so the stored exec bit is what lets the kernel run
  scripts and hooks. cgofuse does not cache symlinks, so each traversal of a
  link costs one `readlink` round trip.
- macOS (macFUSE) supports the same operations; `chflags` and creation-time
  updates succeed without storing anything. FUSE-T is untested.
- Windows (WinFsp) shows directories as `0777` and files as `0666` and never
  sets the exec bit: `chmod` (an ACL edit) and the create mode are ignored
  there. Editing a POSIX peer's executable in place keeps its exec bit; an
  editor that saves through a temporary file and a rename drops it. mtime
  round-trips through `SetLastWriteTime`, but a time before 1970 with a
  sub-second part arrives with a negative nanosecond value and is ignored
  instead of failing. Symlinks created by POSIX peers are readable with
  Developer Mode or `SeCreateSymbolicLinkPrivilege`; absolute POSIX targets
  fail with access denied, and directory links are best effort. Creating a
  file link from Windows fails and leaves an empty file: `CreateSymbolicLinkW`
  creates the file and turns it into a link while its handle is still open,
  which the mount rejects as an overlapping namespace change. A directory link
  is created as a directory first, which the mount commits at once, so it may
  succeed with a target converted by WinFsp; this is unverified. The Windows
  smoke records both outcomes without gating on them. git for Windows defaults
  to `core.symlinks=false`.

On Linux and macOS, inode numbers are libfuse node ids that change after the
kernel forgets an inode; git's default `core.checkStat` compares them, so
`git status` can re-hash such files (correct, but slower).

## Kernel caching and other peers' changes

The adapter keeps no cache of its own. What the kernel caches decides how
soon a mount sees changes made elsewhere: by other peers, and by the daemon's
own conflict and naming merges. Changes made through the mount itself are
visible at once on every platform.

Linux (FUSE 3) mounts with
`-o entry_timeout=0.1,attr_timeout=0,negative_timeout=0`. The kernel remembers
which file a name leads to for at most 0.1 s and caches neither attributes,
missing names nor directory listings. So Linux reads file metadata fresh on
every stat, and names other peers create appear at once.

- Other peers' edits, deletes and renames are visible as soon as they
  replicate. A two-mount probe measured no added delay.
- For up to 0.1 s after another peer changes a path's type (file, directory
  or symlink), calls that use the old cached name can fail. A stat of the name
  fails once with `EIO` and drops the cached name, so the next call is
  correct; a two-mount probe measured this for a file replaced by a directory.
  Opening the name, following it as a link, or walking a path through it (for
  example `foo/bar` after `foo` became a directory) does not drop the cached
  name. Those calls can fail with `ENOTDIR`, `EISDIR` or `EINVAL` on every try
  until the cached name expires. These cases are not measured.
- Creating a file right after another peer deleted it works. The kernel still
  has the old name cached and opens it without `O_CREAT`, so the adapter
  answers that open's `ENOENT` with `ESTALE`, and the kernel retries once with
  a fresh lookup, which then creates the file. Without `ESTALE`, 10 of 10
  such creates failed with `ENOENT`, with a 0.1 s name cache as well as a 1 s
  one. With the shipped settings, 0 of 10 failed. No concurrent appends were
  lost.
- Cost: a stat of a two-component path repeated within 0.1 s of the path's
  last lookup takes one adapter callback instead of three. Once the cached
  names expire, the next stat again costs one callback per path component plus
  one. On a GitHub Linux runner, the benchmark's 2,000-file tree ran
  `git status` in 1.23 s instead of 2.91 s and `git clone` in 27.0 s instead of
  35.6 s.
- cgofuse v1.6.0 clears libfuse's parsed configuration when a FUSE 3 mount
  starts, which silently set every timeout to 0: each `lstat` then cost one
  round trip per path component plus one. `go.mod` therefore replaces cgofuse
  with a fork that drops that line, until
  [winfsp/cgofuse#110](https://github.com/winfsp/cgofuse/pull/110) is released.
  The fork and the `-o` belong together: the fork alone would give libfuse's
  defaults of 1 s for names and attributes.

macOS (macFUSE) keeps macFUSE's defaults: names and attributes are cached for
1 s, and missing names are not cached. Size, mtime and mode of files other
peers change can be up to 1 s stale, and names they create appear at once. A
create within 1 s of another peer deleting the same name may fail with
`ENOENT`; this is not measured.

When macFUSE is absent, cgofuse loads FUSE-T instead. Shared-fs does not test
FUSE-T. FUSE-T serves the mount through a local NFS server whose client caches
attributes for 5 to 60 s, which in a one-off probe hid other peers' changes for
up to 18 s, so the adapter mounts it with `-o noattrcache`.

Windows (WinFsp) keeps WinFsp's own caching. The adapter sets no cache options
there, and its staleness is not measured.

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

See [ci.md](./ci.md) for the native mount CI: hosted Linux and Windows mounts on
every shared-fs pull request, and the optional Scaleway Mac for macFUSE.
