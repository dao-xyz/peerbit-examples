# Peerbit Shared FS CLI

Experimental native mount CLI for `@peerbit/shared-fs`.

Mounted unlink and rename operations always go through the library's exact
node-guarded `mutateNamespaceForMount`. This prevents an in-flight mount request
from deleting a replacement node, preserves replaced/unlinked open descriptor
buffers without recreating their names, and binds open descendants across a
directory rename. It remains a visible-replica CRDT fence rather than a
linearizable cross-peer transaction; concurrent unseen naming events can still
surface as normal shared-filesystem conflicts.

```bash
peerbit-fs create
peerbit-fs create --no-auth
peerbit-fs whoami
peerbit-fs trust <address> <public-key>
peerbit-fs revoke <address> <public-key>
peerbit-fs install-adapter
peerbit-fs mount <address> <mountpoint>
peerbit-fs mount <address> <mountpoint> --native-adapter peerbit-shared-fs-native
peerbit-fs mount <address> <mountpoint> --assume-complete
peerbit-fs status [address]
peerbit-fs conflicts <address> [--fail-if-any [--allow-unverified]]
peerbit-fs naming-conflicts <address>
peerbit-fs resolve-conflict <address> <path> <version-id>
peerbit-fs resolve-naming-conflict <address> <node-id> <keep|restore|delete|move|merge-directory>
peerbit-fs benchmark [address]
peerbit-fs snapshot <address>
peerbit-fs unmount <mountpoint>
peerbit-fs prepare-disposal <address>
```

`benchmark` writes and reads one large file plus a configurable many-small-files
workload. It is a baseline for tracking regressions, not a claim that v0 is
optimized for code workspaces. It generates a fresh byte corpus by default and
prints its seed; use `--seed <seed>` to reproduce those exact bytes. This avoids
silently measuring content-addressed deduplication on repeated runs. JSON output
also includes the seed. Timings cover filesystem I/O only; corpus generation and
byte verification are excluded.

`status` prints the current native mount adapter, whether its prerequisites are
available on the host, and any missing pieces before optionally opening an
address. Address status also reports write readiness and its durable source.
For a replica that is still joining, the text names what the join waits for,
such as `write readiness: pending (reconciling: 1 of 1 required peer in
flight: <peer>)`, as it stands right after the open: `status` does not wait.
Add `--json` for one JSON document containing `nativeMount` and either a
`filesystem` object or `null`; its `bootstrap.readiness` is the library's
readiness snapshot (`bootstrapStatus().readiness`: the state and the peers the
join waits for), or `null` when the open runs no join, such as from a
creator's or an already writable state directory. Routine status does not
scan retained conflict metadata; add `--include-conflicts` to include the
current local content and naming records plus separate `contentCount` and
`namingCount` fields. Those whole-store scans are deliberately opt-in because
they can dominate status latency and memory on a large/history-heavy workspace.
During bootstrap the diagnostic records may be partial; check their `partial`
flag and the adjacent bootstrap phase before treating them as an operator
fence. `partial: false` requires a stable, write-ready full replica whose
accepted snapshot coverage was verified for the entire scan. Observer,
off/plain-join, fetching, overlay-active, unverified, and changing bootstrap
views remain partial. The records also report their local-replica scope and
before/after phases; even a verified local scan is not a global network
frontier.

`create` creates an access-controlled filesystem rooted at the local Peerbit
identity. Use `create --no-auth` only for explicitly unauthenticated test/demo
filesystems. Another machine can run `peerbit-fs whoami` to print its writer
key; the owner can then run `peerbit-fs trust <address> <public-key>` to
authorize that writer.

## Inspect and resolve conflicts

Content conflicts preserve every concurrently written head. Inspect all of
them, or one file/path prefix, before explicitly choosing the version whose
bytes should become visible:

```bash
peerbit-fs conflicts "$ADDRESS" --json
peerbit-fs conflicts "$ADDRESS" --path /docs/report.md
peerbit-fs resolve-conflict \
  "$ADDRESS" /docs/report.md <version-id> --json
```

The JSON document includes address, path filter, view metadata, and a
`conflicts` array. Each record contains the file's `nodeId`,
`visibleVersionId`, and one head per distinct content in the converged local
view (heads holding the same bytes are listed once, and any of them can be
selected): immutable version id, content hash, mode, mtime, parent ids, author,
machine, size, and creation time. Size and times are decimal strings so the
output is safe to parse in JavaScript.
`snapshotCoverageVerified` means only that every id in the accepted signed
snapshot was covered before overlay retirement; it is not a global/log-frontier
claim and remains false for bootstrap-off/plain-join views. Inspection still
permits `--no-replicate` for an existing local store, but its
`fullReplica: false` view does not prove completeness. Resolution writes a new
version that references the selected bytes and causally supersedes the heads
visible when it executes; the other immutable versions remain readable until
normal retention/GC policy eventually permits retiring them from logical
history.

### Fail CI on conflicts

`conflicts --fail-if-any` prints the content listing as before, then each
naming conflict's type and path (`--json` adds a `namingConflicts` array), and
exits with:

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| 0      | No conflict, in a view verified complete.           |
| 3      | A conflict, content or naming.                      |
| 4      | No conflict, but the view is not verified complete. |
| 1      | An error.                                           |

A view is verified complete when `view.snapshotCoverageVerified` (above) is
true: a full replica (the default; not `--no-replicate`) that joined through a
snapshot bootstrap from a reachable peer, such as a CI job's fresh
`--directory`. In any other view no conflict proves nothing, so the gate fails
with 4; `--allow-unverified` accepts the local view and exits 0 instead.
`--path` limits both kinds to a file or path prefix:

```bash
peerbit-fs conflicts "$ADDRESS" --fail-if-any || {
  code=$?
  [ "$code" -eq 3 ] && echo "unresolved shared-fs conflicts" >&2
  [ "$code" -eq 4 ] && echo "no peer verified the shared-fs view" >&2
  exit "$code"
}
```

`naming-conflicts` has no such flag: one gate covers every kind. A native mount
shows the same conflicts as read-only copies under `/.peerbit-conflicts` (see
the library README's "Conflicts" section).

### Naming conflicts

Namespace conflicts are inspected and acted on separately:

```bash
peerbit-fs naming-conflicts "$ADDRESS" --json
peerbit-fs resolve-naming-conflict \
  "$ADDRESS" <node-id> keep
peerbit-fs resolve-naming-conflict \
  "$ADDRESS" <node-id> move --to /recovered/report.md
peerbit-fs resolve-naming-conflict \
  "$ADDRESS" <shadowed-directory-node-id> merge-directory --json
```

The optional naming `--path` is an output filter; naming conflict discovery
still rebuilds the local namespace state before filtering.

Use the conflict type and listed ids deliberately:

- `multi-head`: `keep` normally asserts the deterministic visible placement.
- `duplicate-name`: move or delete one of the listed `shadowedNodeIds` (keeping
  the visible winner alone normally leaves the collision unresolved). When
  both claimants are directories, `merge-directory` moves every observed live
  direct child of one shadowed claimant into the visible directory without
  changing node ids; nested subtrees follow their directory node, while child
  name collisions remain explicit duplicate-name conflicts. Resolve any
  source, target, or direct-child node with multiple naming heads first; the
  merge fails before publishing a partial repair.
- `delete-vs-edit`: `restore` recovers surviving edited content; `delete`
  acknowledges the currently visible content heads.
- `unreachable`: move the node below a reachable directory, or delete it.

`move` can itself target an occupied slot and create another duplicate-name
conflict, so inspect again after every action. The resolution JSON returns the
conflicts observed before the action and any still involving that node
afterwards. A successful directory merge additionally reports its source and
target node ids, moved direct-child ids, and naming-event ids.

Resolution commands reject `--no-replicate`, wait for write readiness, require
the local identity to be trusted on authenticated filesystems, and reject ids
that are not part of the currently visible conflict. Naming actions pass the
complete listed conflict records into the library. The library rechecks their
exact local topology—including other duplicate-name claimants and recoverable
delete-vs-edit versions—and fails retryably if it changed before execution.
Delete/restore also publish only against content heads snapshotted before that
final check, so later content stays recoverable or concurrent. This is a local
observed-view fence, not a global transaction: an event arriving after that read
can reintroduce a conflict later. Directory merge is likewise bounded and
observed-view-only: its child moves and source tombstone are submitted in one
local batch with the tombstone last, but replicas may ingest those independent
events in another order; there is no cross-node causal edge or remote
atomicity. Reinspect before retrying after a reported publication error. A
child first seen later beneath the deleted source is surfaced as an
`unreachable` conflict and can be moved into the merged tree. Content resolution
reports both the heads observed during CLI preflight and the heads actually
superseded so automation can detect its corresponding race. Neither command
waits for persisted remote acknowledgements; run `prepare-disposal` separately
before retiring the resolving machine.

## Install

Install the CLI, then make sure the native adapter is installed:

```bash
npm install -g --omit=peer @peerbit/shared-fs-cli
peerbit-fs install-adapter
peerbit-fs status
```

`--omit=peer` keeps npm from auto-installing optional browser and React Native
peer packages that are not needed by the Node.js CLI.

`peerbit-fs install-adapter` downloads the prebuilt
`peerbit-shared-fs-native` binary from this CLI's own release into
`~/.peerbit/shared-fs/bin/shared-fs-native-v<cli version>/` and pins it there
with `peerbit-shared-fs-native.install.json` (release tag, target, and binary
SHA-256). Each release has its own directory, so CLIs of different versions
(for example under two Node versions) keep their own adapters side by side.
The global package install also tries this automatically. Both keep an
adapter only when its pin matches this CLI and replace a stale, modified, or
unpinned one; `--force` always reinstalls. The explicit command is safe to
rerun and is the easiest way to repair a missing adapter. Adapters that older
CLIs installed directly in `~/.peerbit/shared-fs/bin` are no longer used and
can be deleted.

`mount` and `status` auto-detect this CLI's managed adapter, a
`peerbit-shared-fs-native` command on `PATH`, or
`PEERBIT_SHARED_FS_NATIVE_ADAPTER`. Only the adapter from this CLI's release is
supported: `mount` refuses a managed adapter whose pin is missing, names
another release or platform, or no longer matches the binary, and its error
names both versions; `status` then reports the mount as unavailable with the
same reason. Run `peerbit-fs install-adapter --force` to fix it. An adapter
chosen with `--native-adapter`, `PEERBIT_SHARED_FS_NATIVE_ADAPTER`, or `PATH`
is not checked and is your responsibility: IPC v1 is retired, so an adapter
from 0.13.15 or earlier still mounts but fails every operation, and CLIs from
0.13.15 or earlier cannot use current adapters.

Native runtime prerequisites are platform-specific:

- Linux: FUSE/libfuse. On Debian or Ubuntu, install `fuse3` and
  `libfuse3-dev`.
- macOS: macFUSE. With Homebrew, run `brew install --cask macfuse`, then approve
  macFUSE in System Settings and reboot if macOS requires it.
- Windows: WinFsp runtime must be installed before mounting.

Mounts keep each file's exec bit and mtime and support symlinks: `chmod`
keeps only the exec bit, `touch` sets mtime, and `ln -s` creates a link.
`chown` succeeds without storing an owner; files report the mounting user.
Windows never sets the exec bit. It creates file and directory symlinks
(`mklink`, `mklink /D`, `New-Item -ItemType SymbolicLink`) with a relative
target, or an absolute target on the same mount, which is stored relative to
the link, and it follows links that POSIX peers create with relative targets.
It cannot create junctions or hard links or link to a target off the mount,
and it cannot read a POSIX peer's link with an absolute target. A
delete-on-close file disappears when its handle closes.
`packages/shared-fs/native/README.md` lists the per-platform limits. These
fields are not an authorization boundary. The external adapter's OS access
callback checks only existence and the exec bit, so `test -w` is advisory.
Use the Shared FS trusted-writer model for write authorization.

A Linux mount caches which file a name leads to for at most 0.1 s and never
caches file metadata or missing names, so other peers' changes appear as soon
as they replicate. macOS caches names and metadata for 1 s. On Windows,
WinFsp's own caching added no measured delay: other peers' changes appeared
as soon as they replicated. `packages/shared-fs/native/README.md` describes
each platform's caching and its edge cases.

Path names have no portable cross-platform policy yet. The library compares
case-sensitive strings without Unicode normalization or Windows reserved-name
mapping/rejection, so mixed-platform deployments must enforce a common naming
subset before exposing names through native mounts.

Create and mount an authenticated shared filesystem:

```bash
peerbit-fs status
ADDRESS=$(peerbit-fs create)
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

For a diagnostic run, add `--mount-profile <dir>`. The CLI creates the
directory if needed and refuses to reuse existing profile files. It writes
`<dir>/node-daemon.ndjson` (IPC backend service, local commit fences, the
exact Peerbit-facing `writeFile` call, and that call's sequential `writeFile.*`
sub-phases such as chunk I/O and the version and naming document puts) and
asks a profiling-capable external adapter to write
`<dir>/native-adapter.ndjson` (native callbacks, IPC queue, and IPC round
trips). Older adapters ignore the request and mount normally;
native-adapter records require an adapter release that includes profiling.
Profiling is opt-in, uses bounded asynchronous file writers that drop and
count records instead of slowing the mount, and does not change mount
semantics. Stop the mount with Ctrl-C so both files end with a
`profile.summary` record.

From a repository checkout, summarize a run (optionally attributing records to
a mounted benchmark report):

```sh
node scripts/shared-fs-mount-profile-summary.mjs --profile-dir ./mount-profile \
  --benchmark run=./benchmark.json --markdown ./summary.md --json ./summary.json
```

The phases nest: a native callback contains its IPC round trip, which contains
the daemon's service time, which can contain a local commit fence and its
target write, which contains its `writeFile.*` sub-phases. Do not add a phase
to the phase that contains it; the summary's "writeFile breakdown" table shows
each sub-phase's share of the target write. Kernel scheduling and cache time,
remote readability, replication, and persisted acknowledgements are not
reported.

On Windows PowerShell:

```powershell
peerbit-fs status
$address = peerbit-fs create
New-Item -ItemType Directory -Force "$env:USERPROFILE\PeerbitShared"
peerbit-fs mount $address "$env:USERPROFILE\PeerbitShared"
```

Authentication is on by default. Use `peerbit-fs create --no-auth` only for
explicitly unauthenticated tests or demos. Authentication controls writer
admission only: Shared FS has no reader ACL and does not encrypt names or file
bytes.

## Share With Another Machine

On the joining machine, print the local Peerbit writer key:

```bash
peerbit-fs whoami
```

On a machine that already owns or can write the filesystem, authorize that key:

```bash
peerbit-fs trust "$ADDRESS" <public-key>
```

To remove the trust edge owned by that same authorizing identity, run:

```bash
peerbit-fs revoke "$ADDRESS" <public-key>
```

Revocation is directional and eventually convergent. Another live trust path
keeps the key trusted, so inspect the command result, quiesce and isolate the
revoked machine, and use the serving-replica checks described below before
treating the revocation as enforced.

The joining machine can then mount the same address:

```bash
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

`mount` opens a full replica and waits until it has proven its initial view
before exposing a writable filesystem: every peer it can see running the
filesystem has been reconciled with, has left, or was caught in a provable lie,
and at least one of them is a write-ready full replica. See the library
README's "Write readiness on joins" section. During that window library
mutations and writable backend opens return retryable `EAGAIN`; reads remain
available. A mount from a state directory that was already writable for this
filesystem, such as the creator's, is writable at once, also offline.
`mount --no-replicate` is rejected because an observer cannot establish the
complete namespace required for safe mounted writes. Readiness covers the peers
a mount can see, not a global log frontier, so deployments requiring a strict
frontier should keep writers stopped until Peerbit exposes that upstream
barrier.

Mounted `flush` publishes one frozen buffer generation. `fsync` and close drain
every mutation accepted before their fence, while mutations racing a closing
handle fail instead of disappearing. A truncate to empty that is a file's only
change since its last commit (a shell redirect before its first write) is the
exception: a flush, or the close of another descriptor, publishes nothing until
a later write is flushed or the descriptor that emptied the file is fsynced or
closed. A background job started with `> file` therefore leaves the previous
bytes visible to other replicas until then. See the library README's "Native
Mounts" section. These calls do not wait for a remote
persisted quorum; use the quiesced `prepare-disposal` workflow for machine
retirement. CI verifies the default disk-backed store after forced process
termination, not arbitrary custom targets or a host/controller power failure.

For access-controlled filesystems, write readiness is not a global revocation
proof. The trusted-writer graph converges separately and entries do not carry
an authorization epoch, so quiesce and isolate a revoked machine/key, wait for
every serving replica to report it untrusted, and keep an already-converged
durable replica online. A signed trust frontier and entry-bound authorization
epoch are still needed upstream for protocol-grade revocation. Readiness does
not wait out the revocation window either: a mount that never held a revoked
grant can become writable while a stale peer's copy of that grant makes it
trust the revoked writer, until a peer holding the revocation offers it (about
a second while such a peer is connected).

`create` requires a full replica and records it as the filesystem's creator,
so a `mount` from the same state directory is writable at once. It also
publishes a signed zero-document genesis manifest, which tells a joiner's
snapshot bootstrap discovery that nothing has been written yet; `create` fails
if it cannot publish it. Until something is written, the creator publishes it
again whenever another peer opens the filesystem. `create --no-replicate` is
rejected.
`mount` waits up to 120 seconds by default; tune this with
`--write-ready-timeout-ms`, an integer from 1 to 2147483647 milliseconds
(Node's timer limit; the same holds wherever the flag appears). A timeout is
not permission to write. Its error
names what the mount waited for and the advice that fits: usually keep a
complete replicator for this filesystem connected and retry. Another replicator
does not help when a required peer is reachable but does not answer (restart
or stop that peer) or when the peers that answered are not write-ready
themselves (connect a write-ready replica, such as the creator). When every
required peer was accounted for and the mount was still persisting its
readiness proof, retry; if that repeats, check that the Peerbit directory is
writable. An unrelated connected Peerbit peer does not count, and a fresh mount
always needs a write-ready replica online, such as the creator. A populated
state directory whose readiness state was lost cannot certify itself: it is
gated like a fresh mount until it reconciles with such a replica.

While it waits, a mount that is not yet writable shows one progress line on
stderr, such as `write readiness: reconciling: 1 of 2 required peers in
flight: <peer> (1 contained)`: the library's readiness state, the peers it
waits for and how many it has reconciled with. It is updated when a peer's
state changes, not on a timer. In a terminal it is rewritten in place and
cleared when the wait ends; otherwise each new readiness state prints one
line. A mount that is writable at once prints nothing here. Once writable,
`mount` prints where readiness came from, `write readiness: ready (<source>)`:
`creator`, `reconciled` (the join proved its view) or `operator`
(`--assume-complete`). `resolve-conflict` and `resolve-naming-conflict` wait
the same way and show the same line.

A remount from a writable state directory also prints `freshness: <state>`:
whether it has yet compared its view with the peers it can see (see the library
README's "Warm freshness"); it is writable either way. `mount --require-fresh`
waits for that comparison instead, within `--write-ready-timeout-ms`; offline
it times out, and a mount without the flag writes on the replica's own earlier
proof. It cannot be combined with `--assume-complete` or
`--allow-partial-writes`. `status` prints the same line (`freshness` in
`--json`); like every command but `mount`, it compares only if a peer asks it,
so it usually reports `unchecked`.

When no write-ready replica will answer, for example because the creator is
gone for good, or a peer stays silent and cannot be restarted, a join cannot
prove its view. If you know this replica's view is complete, add
`--assume-complete` to `mount`, `resolve-conflict` or
`resolve-naming-conflict`. The command still waits for the proof first. Only if
`--write-ready-timeout-ms` passes without it, and no required peer can still
answer (the join has no peer, only peers that are not write-ready, or only
required peers that refused or stay silent), does the CLI call the library's
`assumeComplete()` and print a warning with the reason. The replica then
becomes writable and records source `operator`, so unlike
`--allow-partial-writes` it persists: later runs from the same state directory
are writable at once. Rows held only by peers it did not reconcile with are
missing from its view, and writes made after it can conflict with them. While a
required peer is still being asked, also beside one that stays silent, it may
yet answer and the view gain its rows, so the command fails with the timeout
and says that the flag was not applied. It cannot be combined with
`--allow-partial-writes`, and it is not applied while a snapshot overlay is
fetching or active. An overlay retires within 15 minutes, but only within one
long run. Every run, including a short `peerbit-fs status`, starts again from
the phase the last one left, so retrying does not help: keep the command open
with a `--write-ready-timeout-ms` that covers it, such as 960000; the error
names the phase and the value. An unverified bootstrap (an overlay that retired
before its rows were covered, or one resumed over a partial store) does not
hold the flag back, and a join's proof ends it without the flag. Without the
flag, a timeout of one of these commands whose join has no peer, only peers
that are not write-ready, or only required peers that refused or stay silent
ends with a hint naming `--assume-complete` and, while an overlay is fetching
(a fetch that succeeds installs one) or active, the wait it needs.

Readiness proves a mount's view against the peers it can see, not against
writers that are offline or rows a peer received after it answered. A replica
that missed writes while offline, such as a creator restarting after another
machine wrote and left, answers from its own view, so a mount that reaches only
that replica becomes writable on a stale view; a remount from a writable state
directory is likewise writable offline from its own state. The missed writes
merge when a peer holding them comes back, and no stored version is deleted:
clashing edits become conflict copies and clashing paths naming conflicts,
whose visible choice can flip. Files can still end up inconsistent with each
other, such as a git repository's refs and objects. Readiness covers paths and
file versions, not file contents: a new mount can be writable while content is
still arriving, and reading such a file fetches it from a peer. See the library
README's "Write readiness on joins" section for what readiness proves and its
"Conflicts" section for which saves on a stale view are kept.

The `--allow-partial-writes` mount escape hatch is a session-only recovery
bypass. It can manufacture duplicate paths or overwrite from stale state, does
not persist proof, and keeps snapshot, GC, ACL, and disposal operations blocked.
Unlike `--assume-complete`, which records a lasting operator assertion after
the wait for a proof timed out, it skips the wait and lasts for this session
only.

`peerbit-fs snapshot <address>` publishes a cold-start snapshot that later
joiners bootstrap from. It first waits for this replica's write readiness
(`--write-ready-timeout-ms`, default 120 seconds; there is no
`--assume-complete`, because a snapshot from an assumed view would take
precedence over complete ones), then for any snapshot bootstrap to settle, and
refuses to publish an empty tree. A fresh state directory therefore needs a
write-ready replica online, as a mount does. From a state directory that is
already writable, it publishes that replica's current view at once, without
waiting for newer rows from peers.

Run `peerbit-fs status "$ADDRESS"` when diagnosing a host. It checks the native
adapter, platform prerequisites, local Peerbit state, and whether the address can
be opened.

## Choose the network: `--peer` and `--bootstrap`

By default, commands that open a filesystem by address join the public Peerbit
bootstrap network, whose node list they fetch at startup. Two repeatable
options change that, and both are used when given together:

- `--peer <multiaddr>` dials that peer, such as a hub, and keeps the command
  off the public network.
- `--bootstrap <multiaddr>` uses that node instead of the public list, which
  is then not fetched.

Each takes every value that follows it, so put them after the positionals:

```bash
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared" \
  --peer /ip4/192.0.2.10/tcp/4002/p2p/<hub peer id>
```

`mount` starts while they are down: it warns, naming each `--peer` it could
not dial, or the `--bootstrap` list when none of its nodes answers, and goes
on. A remount from a writable state directory is writable at once (unless
`--require-fresh`); a first mount still needs a peer that holds the filesystem
to answer within about 30 s, or fails naming what it could not reach.

Peerbit's pubsub keeps every `--peer` and `--bootstrap` address while the
mount runs, whatever its first dial did, and dials a down one again. How soon
depends on whether another of these addresses is connected:

- None is, as with a single `--peer`: it redials about once a second, so a hub
  restarted at the same address is usually back within about 2 s.
- One is, as with `--bootstrap` and `--peer` together, or several of either:
  the mount dials a down address when it writes, so a write made after the hub
  is back reaches it within about a second. An idle mount dials it only about
  once a minute, so it can take that long to sync with that hub again. A
  faster idle redial needs a change in Peerbit.

Without `--peer`, the mount also enables Peerbit's bootstrap recovery: while
it has no connections at all, it bootstraps again from `--bootstrap` (else the
public list), 1 s after a failed attempt, doubling to at most 60 s with 20%
jitter. That fallback guarantees retries; it is not the dial rate. A `--peer`
mount skips it: a new bootstrap pins the mount's pubsub topic roots to the
nodes it reached, and a mount that switched so while connected stalled other
machines' joins for about a minute. Give every machine of a filesystem the
same `--bootstrap` list.

A `--peer` with `/p2p/<id>` accepts only that identity, so the hub must keep
its state directory to be redialled: one that returns with a new identity is
refused on every redial, silently. Without `/p2p/`, any peer at that address
is accepted, which authenticates the hub less. A connection that dies without
closing, as across a laptop's sleep, counts as connected until Peerbit or
libp2p drops it: with a hung hub, that took about 12 s while the mount wrote
and about 2 minutes while it was idle.

Other commands fail at once, naming the address, when a `--peer` cannot be
dialled or no `--bootstrap` node answers. The options apply to `mount`,
`status`, `conflicts`, `naming-conflicts`, `resolve-conflict`,
`resolve-naming-conflict`, `trust`, `revoke`, `gc`, `snapshot`,
`prepare-disposal` and `benchmark`; `status` and `benchmark` without an
address connect to nothing. `--no-replicate` reads that skip the public network
still dial `--peer` and `--bootstrap`.

## Stop a mount: persist-on-exit

Ctrl-C, SIGTERM, SIGHUP, Ctrl-Break (Windows) or a `shutdown` line on a piped
stdin stops `mount`: the adapter detaches, files still open are saved, and,
if another replica of the filesystem was seen in this session, `mount` waits
up to `--persist-timeout-ms` (default 30000) until another replica holds each
entry it wrote in this session and the names of the files and directories it
changed and of every directory above them (an earlier run's names too). With
no replica seen it does not wait and says so. An earlier run's own files are
not covered if it was killed. The wait sends the
whole session again (on loopback about 4,000 entries, or 64 MiB, in a second):
raise the timeout for long sessions or slow links. `--no-persist-on-exit`
skips the wait only.

A second request aborts the wait while it runs (the list is printed, then
`mount` exits at once, without stopping Peerbit) and otherwise exits at once.
One within 100 ms of the last is taken for the copy of a Ctrl-C that npm, pnpm
and npx pass on: it only prints a hint. Windows has no SIGTERM: `taskkill` and
`child.kill()` skip all this, so send `shutdown`; a closed console window
leaves about 10 s.

Exit codes: 0 stopped; 1 failed, or an open file could not be saved
(`persist-on-exit: unsaved {"path":...}`); 75 the wait gave up, with one
`persist-on-exit: unacknowledged {"path":...,"ids":[...]}` line per path (ids
with no path: `"path":null`; 200, then `unlisted {"paths":n}`) for writes
that stay saved here with no receipt; 130 a second request stopped it. 1 is
kept over 75 and 130, and 75 over 130. Unlike `prepare-disposal`, it fences
only this session's own writes, while other writers keep writing; retire a
machine with `prepare-disposal`.

## Safely dispose of a machine

Stop mounted writes, wait for persisted delivery, and only then dispose of the
machine or delete its local Peerbit state:

```bash
# In the original mount terminal, send Ctrl-C/SIGTERM and wait for
# `peerbit-fs mount` to finish its clean shutdown.
peerbit-fs prepare-disposal "$ADDRESS" --min-acks 1
# Only after both commands exit successfully, dispose of the machine or its state.
```

`peerbit-fs unmount "$MOUNTPOINT"` only detaches the OS mountpoint; it does not
stop a separately running `peerbit-fs mount` process. If manual unmounting is
needed, still terminate that original process and wait for it to exit before
opening the same Peerbit state directory for the barrier.

`--min-acks <number>` defaults to `1`, `--timeout-ms <number>` bounds the
barrier after the filesystem has opened, and `--json` emits a machine-readable
result. Network connection, filesystem open, and shutdown are outside that
flag's deadline. A timeout, abort, error, or nonzero exit never indicates safe
disposal. Keep the source machine and its state available, correct connectivity
or storage capacity, and retry the barrier. Run it against the existing full
local replica; `--no-replicate` is rejected. A pending bootstrap decision is
awaited; a bootstrapping or unverified view is rejected. Any filesystem-content
or trusted-writer-graph arrival during the fence also fails the attempt. A
deferred resurrection-guard decision for removed live metadata fails closed
until it settles, so let replication and guard recovery settle before retrying.
Avoid tight retry loops after a timeout: already-started local index/log reads
cannot be cancelled and finish in the background.

The captured recoverable head closure contains every current naming head
(including tombstones and conflicts), every current file-version head, and
every distinct chunk those versions reference, plus every surviving
trusted-writer-log entry (live grants and revocation tombstones). It does not
preserve already superseded filesystem history or control manifests.

The reported guarantee is persisted **per entry**: every exact entry in that
closure independently reached the requested number of capable remote leaders
backed by supported durable storage. It does not prove that one common
custodian, or the same group of custodians, holds all entries. The command does
not raise the replication degree, and older, incapable, in-memory, and local
peers do not count.

Receipts describe the instant they were issued and assume cooperative remotes;
they are not permanent-custody guarantees or Byzantine proofs. A successful
empty result is vacuous: it acknowledges no data and provides no evidence that
a remote peer was present. The command does not revoke the local writer key;
perform any intended revocation first. If a cold receipt target cannot validate
a revocation tombstone because it never admitted the original grant, the
barrier fails closed instead of claiming disposal safety.

The portable process-crash campaign kills all three authenticated replica
instances without graceful shutdown after `minAcks: 2`, deletes the source, and
reopens each custodian alone. That verifies the application-crash path on the
tested disk backend. A literal power-cut claim still requires a VM or hardware
fault campaign with explicit filesystem and controller-cache semantics.

## macOS from this repo

For repository development, the macOS installer builds the TypeScript CLI and
the external Go/macFUSE adapter, then installs wrappers into `~/.local/bin`:

```bash
pnpm shared-fs:install:macos
export PATH="$HOME/.local/bin:$PATH"

peerbit-fs status
ADDRESS=$(peerbit-fs create)
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

macFUSE is required. The installer tries `brew install --cask macfuse` when
Homebrew is available, but macOS may still require one-time approval in System
Settings > Privacy & Security and a reboot.

The external `packages/shared-fs/native` adapter uses cgofuse for Linux FUSE,
macFUSE, and WinFsp. The `Shared FS Native Smoke` GitHub workflow mounts for
real on every shared-fs pull request: Linux FUSE and Windows WinFsp on
GitHub-hosted runners. macFUSE cannot load on hosted runners, so its smoke runs
on demand on a Scaleway Mac (`Shared FS Native OS Smoke`). Portable CI still
runs the backend and cross-OS shared-store checks on Linux, macOS, and Windows.
