---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Authenticate every native mount IPC connection. On macOS and Windows,
`peerbit-fs mount` serves the adapter on TCP loopback, and any local user could
connect to that port, negotiate IPC v2, and read, write, or delete files in
another user's mounted filesystem.

`createSharedFsIpcServer` now generates a random 256-bit token for each server
and exposes it as `token` on the returned server. The IPC v2 negotiation offer
carries it in a new `token` member. The server compares it in constant time,
answers an offer without it, or with any other value, with an `EACCES` error,
and closes the connection before it selects a version or runs any operation.
The check applies on every endpoint, including the Linux owner-only Unix
socket, so a private socket path is no longer needed to keep a macOS or
Windows daemon private. `peerbit-fs mount` hands the token to the adapter it
starts, managed or chosen with `--native-adapter` or
`PEERBIT_SHARED_FS_NATIVE_ADAPTER`, in the `PEERBIT_SHARED_FS_IPC_TOKEN`
environment variable, never in its arguments, which other local users can
list. The adapter unsets the variable, so no process it starts inherits it.

Wire break: an adapter from an earlier release does not send the token, so the
daemon refuses it at mount startup with an error that says to run
`peerbit-fs install-adapter --force`. Embedders that drive the server with
their own client must present `server.token` in the offer (see
`IPC_PROTOCOL_V2.md`, whose golden negotiation vector now carries a token).

The adapter change reaches users through this CLI version's adapter release
(`shared-fs-native-v<version>`), which the release publishes automatically.
Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.
