---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Reuse one serialized IPC connection for each external native mount session, reconnect only after surfacing a transport failure, make mount startup and IPC-server shutdown terminate retained resources, and add portable transport benchmarks across metadata and 4 KiB through 1 MiB payloads.
