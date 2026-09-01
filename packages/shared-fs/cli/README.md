# Peerbit Shared FS CLI

Experimental native mount CLI for `@peerbit/shared-fs`.

Mounted unlink and rename operations use the library's exact node-guarded
namespace capability when available. This prevents an in-flight mount request
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
peerbit-fs install-adapter
peerbit-fs trust-legacy-replica <address> --assume-local-replica-complete
peerbit-fs mount <address> <mountpoint>
peerbit-fs mount <address> <mountpoint> --native-adapter peerbit-shared-fs-native
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs benchmark [address]
peerbit-fs unmount <mountpoint>
peerbit-fs prepare-disposal <address>
```

`benchmark` writes and reads one large file plus a configurable many-small-files
workload. It is a baseline for tracking regressions, not a claim that v0 is
optimized for code workspaces.

`status` prints the current native mount adapter, whether its prerequisites are
available on the host, and any missing pieces before optionally opening an
address. Address status also reports write readiness, its durable source, and
whether the local directory is eligible for one-time legacy promotion.

`create` creates an access-controlled filesystem rooted at the local Peerbit
identity. Use `create --no-auth` only for explicitly unauthenticated test/demo
filesystems. Another machine can run `peerbit-fs whoami` to print its writer
key; the owner can then run `peerbit-fs trust <address> <public-key>` to
authorize that writer.

## Install

Install the CLI, then make sure the native adapter is installed:

```bash
npm install -g --omit=peer @peerbit/shared-fs-cli
peerbit-fs install-adapter
peerbit-fs status
```

`--omit=peer` keeps npm from auto-installing optional browser and React Native
peer packages that are not needed by the Node.js CLI.

`peerbit-fs install-adapter` downloads a prebuilt
`peerbit-shared-fs-native` binary into `~/.peerbit/shared-fs/bin`. The global
package install also tries this automatically, but the explicit command is safe
to rerun and is the easiest way to repair a missing adapter. `mount` and
`status` auto-detect that managed adapter, a `peerbit-shared-fs-native` command
on `PATH`, or `PEERBIT_SHARED_FS_NATIVE_ADAPTER`.

Native runtime prerequisites are platform-specific:

- Linux: FUSE/libfuse. On Debian or Ubuntu, install `fuse3` and
  `libfuse3-dev`.
- macOS: macFUSE. With Homebrew, run `brew install --cask macfuse`, then approve
  macFUSE in System Settings and reboot if macOS requires it.
- Windows: WinFsp runtime must be installed before mounting.

Create and mount an authenticated shared filesystem:

```bash
peerbit-fs status
ADDRESS=$(peerbit-fs create)
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

On Windows PowerShell:

```powershell
peerbit-fs status
$address = peerbit-fs create
New-Item -ItemType Directory -Force "$env:USERPROFILE\PeerbitShared"
peerbit-fs mount $address "$env:USERPROFILE\PeerbitShared"
```

Authentication is on by default. Use `peerbit-fs create --no-auth` only for
explicitly unauthenticated tests or demos.

## Share With Another Machine

On the joining machine, print the local Peerbit writer key:

```bash
peerbit-fs whoami
```

On a machine that already owns or can write the filesystem, authorize that key:

```bash
peerbit-fs trust "$ADDRESS" <public-key>
```

The joining machine can then mount the same address:

```bash
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

`mount` opens a full replica and waits until the initial namespace has settled
before exposing a writable filesystem. During that window library mutations and
writable backend opens return retryable `EAGAIN`; reads remain available.
`mount --no-replicate` is rejected because an observer cannot establish the
complete namespace required for safe mounted writes. For now readiness is a
settled-view heuristic rather than a protocol log-frontier proof, so deployments
requiring a strict frontier should keep writers stopped until Peerbit exposes
that upstream barrier.

Mounted `flush` publishes one frozen buffer generation. `fsync` and close drain
every mutation accepted before their fence, while mutations racing a closing
handle fail instead of disappearing. These calls do not wait for a remote
persisted quorum; use the quiesced `prepare-disposal` workflow for machine
retirement. CI verifies the default disk-backed store after forced process
termination, not arbitrary custom targets or a host/controller power failure.

For access-controlled filesystems, write readiness is not a global revocation
proof. The trusted-writer graph converges separately and entries do not carry
an authorization epoch, so quiesce and isolate a revoked machine/key, wait for
every serving replica to report it untrusted, and keep an already-converged
durable replica online. A signed trust frontier and entry-bound authorization
epoch are still needed upstream for protocol-grade revocation.

`create` requires a full replica and publishes a signed empty snapshot, so a
newly created empty filesystem can be mounted locally and later prove its empty
starting view to a connected joiner. `create --no-replicate` is rejected.
`mount` waits up to 120 seconds by default; tune this with
`--write-ready-timeout-ms`. A timeout is not permission to write: keep a
complete replicator for this filesystem connected and retry. An unrelated
connected Peerbit peer does not count. A fresh no-snapshot join can count
namespace rows materialized during the initial store open only when they are
paired with the lower log's successful network-commit phase. Local replay has
no such phase, so a populated store with a missing sidecar cannot certify
itself; when it is already identical to its donor, one later donor mutation or
a verified snapshot is still required.

Pre-marker stores have no persisted readiness proof. Connection alone is
insufficient when local and remote states are already identical, because no new
metadata event may arrive. The normal path is to open the legacy handle, keep a
complete replicator connected, and make one normal namespace mutation on that
replicator. If `peerbit-fs status "$ADDRESS"` reports
`legacy promotion eligible: yes`, and only after independently verifying that
this exact directory was a cleanly shut down, complete full replica that was
never copied mid-bootstrap, run:

```bash
peerbit-fs trust-legacy-replica "$ADDRESS" \
  --assume-local-replica-complete
```

This is an operator assertion, not a network proof. It persists a marker for
this directory/address before enabling writes and is safe to repeat after
success; never copy the marker to another machine. The `--allow-partial-writes`
mount escape hatch is instead a session-only recovery bypass. It can manufacture
duplicate paths or overwrite from stale state, does not persist proof, and keeps
snapshot, GC, ACL, and disposal operations blocked.

Run `peerbit-fs status "$ADDRESS"` when diagnosing a host. It checks the native
adapter, platform prerequisites, local Peerbit state, and whether the address can
be opened.

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
macFUSE, and WinFsp. The repo includes a manual `Shared FS Native Smoke` GitHub
workflow for Linux FUSE. Portable CI still runs the backend and cross-OS
shared-store checks on Linux, macOS, and Windows.
