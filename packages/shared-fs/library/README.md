# Peerbit Shared FS

Experimental shared filesystem primitives for Peerbit.

This package is intentionally marked experimental. It provides the Peerbit-backed
metadata and content model used by the `peerbit-fs` CLI and native mount adapters.

```bash
npm install @peerbit/shared-fs
```

```ts
import { openSharedFs } from "@peerbit/shared-fs";
import { Peerbit } from "peerbit";

const peerbit = await Peerbit.create({ directory: "./peerbit-fs-state" });
const fs = await openSharedFs({
    peerbit,
    machineLabel: "workstation-a",
    rootKey: peerbit.identity.publicKey,
});

await fs.mkdir("/docs");
await fs.writeFile("/docs/hello.txt", new TextEncoder().encode("hello"));
console.log(await fs.readFile("/docs/hello.txt"));
console.log(fs.address);
```

The v0 model is commit-on-close for mounted writes, local-first, and conflict
preserving. Concurrent versions are never overwritten silently; they are exposed
through `conflicts()` and can be resolved with `resolveConflict()`.

When `rootKey` is provided while creating a filesystem, writes are
access-controlled by a trusted-writer graph rooted at that key. Entries must be
signed by a trusted Peerbit identity, and the stored `authorKey` must match the
entry signer. Use `authorizeWriter(publicKey)` to trust another writer.

## CLI

The companion `@peerbit/shared-fs-cli` package installs `peerbit-fs` for native
mounts:

```bash
npm install -g @peerbit/shared-fs-cli
peerbit-fs install-adapter
peerbit-fs status
```

Then create and mount an authenticated filesystem:

```bash
ADDRESS=$(peerbit-fs create)
mkdir -p "$HOME/PeerbitShared"
peerbit-fs mount "$ADDRESS" "$HOME/PeerbitShared"
```

The CLI commands are:

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
```

Mounted writes are buffered by the native adapter and committed as one signed
Peerbit file version on `flush`, `fsync`, or `release`/close.

`peerbit-fs create` is access-controlled by default. Use `peerbit-fs create
--no-auth` only for explicitly unauthenticated test/demo filesystems. Another
machine can join by running `peerbit-fs whoami`; an authorized writer can then
run `peerbit-fs trust <address> <public-key>`.

From this repository on macOS, the local development install path is:

```bash
pnpm shared-fs:install:macos
export PATH="$HOME/.local/bin:$PATH"
peerbit-fs status
```

## Benchmark Baseline

`runSharedFsBenchmark(fs)` and `peerbit-fs benchmark` run a simple baseline
workload: one large file upload/download plus a many-small-files write/list/read
pass. This is meant to track regressions and guide future agent/code workspace
work; v0 does not optimize the small-file workload yet.

## Native Mounts

The TypeScript Peerbit side exposes a small POSIX-ish backend and a local
JSON-lines IPC protocol with `getattr`, `readdir`, `open`, `read`, `write`,
`flush`, `fsync`, `release`, `mkdir`, `rmdir`, `rename`, and `unlink`.
Run `peerbit-fs status` to report the current host platform, selected adapter,
and any missing native mount prerequisites.

The first adapter path is intentionally experimental:

- Linux requires FUSE/libfuse plus `fuse-native` or the external adapter.
- macOS requires macFUSE plus `fuse-native` or the external adapter.
- Windows requires WinFsp plus the external adapter.
- `packages/shared-fs/native` provides an experimental external native adapter
  binary using cgofuse for Linux FUSE, macFUSE, and WinFsp.
  `peerbit-fs install-adapter` downloads the matching prebuilt adapter when a
  release asset exists.

Portable CI covers the shared backend and IPC contract on Linux, macOS, and
Windows, plus a cross-OS interop workflow where all three runners join one
shared filesystem address and read each other's files. The native Linux FUSE
smoke can be run manually with the `Shared FS Native Smoke` workflow. Native
adapter compile checks run in CI for Linux and Windows; macOS native mount smoke
still needs a runner with macFUSE installed.

## Conflicts

Concurrent saves remain addressable versions. The visible file version is only
a deterministic display choice. Conflicting versions are listed through
`conflicts()` and exposed to mount adapters below:

```text
/.peerbit-conflicts/<encoded-path>/<version-id>
```
