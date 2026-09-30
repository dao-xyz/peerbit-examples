---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Make each native mount callback's IPC round trip cheaper. The native adapter
now reads and writes its daemon connection with blocking system calls (except
on Windows). A FUSE callback runs on a thread that cgo locks to it; while it
waited in Go's network poller, each response woke another thread that then
had to hand the wakeup over. In a local macOS measurement from a C thread, as
FUSE calls the adapter, a getattr-shaped round trip took 32 µs at the median
instead of 40 µs.

On Linux, `peerbit-fs mount` now serves the adapter on a Unix socket in a new
owner-only directory, removed on exit, instead of TCP loopback. A round trip
skips the TCP stack (22 µs instead of 40 µs in the same measurement), and
other local users can no longer connect to the daemon, which IPC v2 does not
authenticate. macOS and Windows keep TCP loopback: macOS Unix sockets buffer
only 8 KiB, which Node cannot raise, and made 128 KiB reads 1.7 times slower.
`createSharedFsIpcServer` without an endpoint uses the same transport, and
`defaultSharedFsIpcEndpoint` is removed.

The adapter change reaches users through this CLI version's adapter release
(`shared-fs-native-v<version>`), which the release publishes automatically.
Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.
