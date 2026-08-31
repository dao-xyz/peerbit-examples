# Peerbit Shared FS CLI

Experimental native mount CLI for `@peerbit/shared-fs`.

```bash
peerbit-fs create
peerbit-fs create --no-auth
peerbit-fs whoami
peerbit-fs trust <address> <public-key>
peerbit-fs install-adapter
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
address.

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

Run `peerbit-fs status "$ADDRESS"` when diagnosing a host. It checks the native
adapter, platform prerequisites, local Peerbit state, and whether the address can
be opened.

## Safely dispose of a machine

Stop mounted writes, wait for persisted delivery, and only then dispose of the
machine or delete its local Peerbit state:

```bash
peerbit-fs unmount "$MOUNTPOINT"
peerbit-fs prepare-disposal "$ADDRESS" --min-acks 1
# Only after both commands exit successfully, dispose of the machine or its state.
```

`--min-acks <number>` defaults to `1`, `--timeout-ms <number>` bounds the
overall wait, and `--json` emits a machine-readable result. A timeout, abort,
error, or nonzero exit never indicates safe disposal. Keep the source machine
and its state available, correct connectivity or storage capacity, and retry
the barrier. Run it against the existing full local replica;
`--no-replicate` is rejected. A pending bootstrap decision is awaited; a
bootstrapping or unverified view is rejected. Any filesystem-content arrival
during the fence also fails the attempt, so let replication settle and retry.

The captured recoverable head closure contains every current naming head
(including tombstones and conflicts), every current file-version head, and
every distinct chunk those versions reference. It does not preserve already
superseded history, control manifests, or the trusted-writer graph.

The reported guarantee is persisted **per entry**: every exact entry in that
closure independently reached the requested number of capable remote leaders
backed by supported durable storage. It does not prove that one common
custodian, or the same group of custodians, holds all entries. The command does
not raise the replication degree, and older, incapable, in-memory, and local
peers do not count.

Receipts describe the instant they were issued and assume cooperative remotes;
they are not permanent-custody guarantees or Byzantine proofs. A successful
empty result is vacuous: it acknowledges no data and provides no evidence that
a remote peer was present. The command also does not revoke the local writer
key or claim that a separate writer revocation was durably delivered.

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
