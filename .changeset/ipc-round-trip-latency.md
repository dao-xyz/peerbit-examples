---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Make each native mount callback's IPC round trip cheaper. The native adapter
now reads and writes its daemon connection with blocking system calls (except
on Windows). A FUSE callback runs on a thread that cgo locks to it; while it
waited in Go's network poller, each response woke another thread that then
had to hand the wakeup over.

On Linux, `peerbit-fs mount` now serves the adapter on a Unix socket in a new
owner-only directory under `/tmp`, removed on exit, instead of TCP loopback. A
round trip skips the TCP stack, and other local users can no longer connect to
the daemon, which IPC v2 does not authenticate. macOS and Windows keep TCP
loopback: macOS Unix sockets buffer only 8 KiB, which Node cannot raise, and
made 128 KiB reads 1.7 times slower.

The gains were measured on macOS only, from a C thread as FUSE calls the
adapter, in four runs of 5,000 getattr-shaped round trips per transport. Over
TCP loopback, blocking calls took 32.3 µs instead of 40.7 µs at the median,
and 470 ms instead of 624 ms per 5,000 calls on average. The Linux
configuration, a Unix socket with blocking calls, took 22.5 µs and 379 ms
there. Linux itself has not been measured yet.

`createSharedFsIpcServer` without an endpoint uses the same transport, and
`defaultSharedFsIpcEndpoint` is removed. On macOS the default therefore moves
from a Unix socket under `/tmp`, which other users could not connect to, to
TCP loopback, which they can. Pass a socket path in a private directory to
keep a macOS daemon private.

The adapter change reaches users through this CLI version's adapter release
(`shared-fs-native-v<version>`), which the release publishes automatically.
Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.
