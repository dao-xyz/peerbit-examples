---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Retire the shared-fs native IPC protocol v1 and pin the managed native adapter
to the CLI's own release. This is a deliberate wire break between releases:
old adapters and CLIs are refused, not supported.

Wire break (IPC v1 retired):

- The Node IPC server (`createSharedFsIpcServer`) speaks only negotiated binary
  IPC v2. It no longer serves base64 JSONL v1: an un-negotiated first operation
  is answered with an `EPROTONOSUPPORT` error that says to run
  `peerbit-fs install-adapter --force`, and the connection is closed without
  dispatching it. An offer is only accepted if it includes version 2, and v2 is
  always selected. Native adapters from 0.13.15 or earlier (v1 only) can no
  longer mount with this CLI.
- The Go native adapter offers only `[2]` and fails closed when a server rejects
  or closes the negotiation. It no longer falls back to v1 or starts in v1
  under a tiny request limit, so it cannot serve a CLI from 0.13.15 or earlier.
  It now negotiates before mounting, so an incompatible server fails the mount
  at startup instead of returning EIO on every operation.
- The IPC handshake line has its own fixed 64 KiB bound, independent of the
  server's `maxRequestFrameBytes`. The `ipc.service` profile records always
  report `protocol: "v2"`. The golden negotiation vector now offers `[2]`.

Public API break: the v1-only `createSharedFsIpcClient` export is removed from
`@peerbit/shared-fs`. It had no non-test caller; embedders that drove a mount
backend over IPC need a v2 client (see `IPC_PROTOCOL_V2.md`).

Adapter version pin:

- `peerbit-fs install-adapter` (and the global-install postinstall, which runs
  it with `--if-needed`) writes `peerbit-shared-fs-native.install.json` next to
  the managed binary, recording its release tag and SHA-256. An existing
  adapter is kept only when that record names the requested release
  (`shared-fs-native-v<cli version>` by default) and still matches the binary;
  a stale, modified, or unrecorded adapter, including every adapter installed
  by CLI 0.13.18 or earlier, is replaced. `--if-needed` no longer keeps a stale
  adapter. `--force` always reinstalls.
- `peerbit-fs mount` refuses the managed adapter before opening Peerbit when
  its record is missing, names another release, or no longer matches the
  binary. The error names the installed and required versions and says to run
  `peerbit-fs install-adapter --force`. `peerbit-fs status` reports the same
  check. An adapter chosen with `--native-adapter` or
  `PEERBIT_SHARED_FS_NATIVE_ADAPTER`, or found on `PATH`, is not pinned; the IPC
  v2 handshake still gates its compatibility.

Release note: this CLI requires the native adapter built from this change. The
release script dispatches the `shared-fs-native-v<cli version>` adapter release
when the CLI version is unpublished. Users upgrading from an earlier CLI must
run `peerbit-fs install-adapter --force` if the postinstall did not already
replace the adapter.
