# Peerbit Shared FS

Experimental shared filesystem primitives for Peerbit.

This package is intentionally marked experimental. It provides the Peerbit-backed
metadata and content model used by the `peerbit-fs` CLI and native mount adapters.

```ts
import { openSharedFs } from "@peerbit/shared-fs";
import { Peerbit } from "peerbit";

const peerbit = await Peerbit.create({ directory: "./peerbit-fs-state" });
const fs = await openSharedFs({
    peerbit,
    machineLabel: "workstation-a",
});

await fs.mkdir("/docs");
await fs.writeFile("/docs/hello.txt", new TextEncoder().encode("hello"));
console.log(await fs.readFile("/docs/hello.txt"));
console.log(fs.address);
```

The v0 model is commit-on-close for mounted writes, local-first, and conflict
preserving. Concurrent versions are never overwritten silently; they are exposed
through `conflicts()` and can be resolved with `resolveConflict()`.

## CLI

The companion `@peerbit/shared-fs-cli` package installs `peerbit-fs`:

```bash
peerbit-fs create
peerbit-fs mount <address> <mountpoint>
peerbit-fs status [address]
peerbit-fs conflicts <address>
peerbit-fs unmount <mountpoint>
```

Mounted writes are buffered by the native adapter and committed as one signed
Peerbit file version on `flush`, `fsync`, or `release`/close.

## Native Mounts

The TypeScript Peerbit side exposes a small POSIX-ish backend and a local
JSON-lines IPC protocol with `getattr`, `readdir`, `open`, `read`, `write`,
`flush`, `fsync`, `release`, `mkdir`, `rmdir`, `rename`, and `unlink`.

The first adapter path is intentionally experimental:

- Linux requires FUSE/libfuse and the optional `fuse-native` package.
- macOS requires macFUSE and the optional `fuse-native` package.
- Windows requires a WinFsp adapter binary; the shared IPC contract is present,
  but this package does not bundle that binary yet.

## Conflicts

Concurrent saves remain addressable versions. The visible file version is only
a deterministic display choice. Conflicting versions are listed through
`conflicts()` and exposed to mount adapters below:

```text
/.peerbit-conflicts/<encoded-path>/<version-id>
```
