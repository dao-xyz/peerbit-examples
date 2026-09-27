---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Add opt-in mounted-path profiling. `peerbit-fs mount --mount-profile <dir>`
writes `node-daemon.ndjson` (IPC backend service, one `mount.localCommit`
record per flush/fsync/release/truncate fence, and the nested target
`writeFile`) through a bounded asynchronous writer that drops and counts
records instead of slowing the mount, and ends with a summary record. Records
carry a schema version, Unix-nanosecond start anchors, failure codes, and the
IPC request id and connection port needed to join them with the native
adapter's records. The library exports `openSharedFsMountProfileFile` and
`createSharedFsMountProfileWriter`. Profiling is off by default and adds only a
sink check when disabled.

The CLI asks the external adapter for `native-adapter.ndjson` through the
`PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE` environment variable, so adapters built
before this change ignore it and mount unprofiled. Native callback, IPC queue,
and round-trip records require a native adapter release that includes this
change.
