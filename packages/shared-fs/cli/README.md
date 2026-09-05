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
peerbit-fs mount <address> <mountpoint> --readable-first
peerbit-fs mount <address> <mountpoint> --native-adapter peerbit-shared-fs-native
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs naming-conflicts <address>
peerbit-fs resolve-conflict <address> <path> <version-id>
peerbit-fs resolve-naming-conflict <address> <node-id> <keep|restore|delete|move|merge-directory>
peerbit-fs benchmark [address]
peerbit-fs unmount <mountpoint>
peerbit-fs prepare-disposal <address>
```

`benchmark` measures one large file and a configurable small-file workload. It
uses a fresh corpus and reports a reproducible `--seed`, avoiding accidental
content-addressed deduplication. Treat it as a regression baseline, not an
optimization claim; older results included extra work and are not comparable.

`status` reports adapter prerequisites, write readiness, durable source, and
legacy-promotion eligibility. Use `--json`; add `--include-conflicts` only when
the cost of a whole-store conflict scan is acceptable. During bootstrap, honor
the reported `partial` flag. See the
[operator guide](https://github.com/dao-xyz/peerbit-examples/blob/master/packages/shared-fs/cli/OPERATOR_GUIDE.md)
for field semantics and safety limits.

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

Resolution requires a trusted, write-ready full replica and remains a local
observed-view fence, not a global transaction. Reinspect after every action;
`move` and directory merging can expose further conflicts. Resolution does not
wait for persisted remote acknowledgements. The
[operator guide](https://github.com/dao-xyz/peerbit-examples/blob/master/packages/shared-fs/cli/OPERATOR_GUIDE.md)
documents record fields, naming actions, race behavior, and disposal safety.

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

Native modes, ownership, and timestamps are synthetic; chmod, chown, and
explicit timestamp updates are unsupported. OS access checks are advisory, not
an authorization boundary. Use the Shared FS trusted-writer model.

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

`mount` waits for a settled full replica before exposure. `--readable-first`
instead exposes the current local read view while mutations remain gated:
POSIX callers receive retryable `EAGAIN` and Windows callers `EBUSY`. Missing
paths are not authoritative until write readiness. Use the default mode for
applications that do not retry transient write errors. Observer mounts and the
partial-write bypass are rejected.

`flush`, `fsync`, and close fence accepted local mutations but do not prove a
remote persisted quorum. Write readiness is not a global revocation proof; see
the operator guide before revoking a writer or retiring a machine.

`--write-ready-timeout-ms` bounds the readable view, abortable adapter startup,
and write readiness under one deadline. Timeout or Ctrl-C/SIGTERM joins startup
and ordered cleanup; it never grants permission to write. Keep a complete
replicator connected and retry.

Legacy promotion is an operator assertion, not a network proof. Follow the
operator guide exactly and never copy its marker. The partial-write option is a
session-only recovery bypass that can create conflicts or overwrite stale data.

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

`--min-acks` defaults to one and `--timeout-ms` bounds only the barrier after
open. Timeout, abort, error, or nonzero exit is never disposal safety. Keep the
source state, correct the problem, and retry from a settled full replica.

The receipt covers each current recoverable naming, content, chunk, and trust
entry independently on the requested number of capable durable leaders. It
does not raise replication, identify one common custodian, preserve superseded
history, revoke the local writer, prove permanent custody, or constitute a
Byzantine or literal power-cut proof. See the operator guide for full semantics.

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

The external adapter uses cgofuse. Because its `Init` can precede attachment,
`ready` signals initialization only. With exclusive mountpoint ownership, the
CLI proves attachment when reserved `.peerbit-conflicts` is absent before spawn
and accessible afterward. Manual native
workflows mount Linux FUSE, macFUSE, and WinFsp, checking the early read,
transient mutation error, writable transition, and detach. Portable PR CI still
does not mount the real operating-system filesystems.

Readable-first requires this abortable external adapter; fuse-native startup
cannot safely guarantee that a timed-out in-process mount will not attach later.
