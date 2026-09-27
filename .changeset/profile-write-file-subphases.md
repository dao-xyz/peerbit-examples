---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Break the library `writeFile` behind each profiled mount commit into
sequential sub-phases. With `--mount-profile` (or a backend `profile` sink),
`node-daemon.ndjson` now also holds `writeFile.*` records: `prepare`,
`resolvePath`, `readHeads`, `hash`, `loadBase`, `chunk`, `touchChunks` (W1
dedup probes, witness queries and chunk puts, with counts, bytes and dedup
skips), `guard`, `versionPut`, `cacheApply`, `verifyChunks` (W2),
`resolveParent`, `namingPut` and `result`. They carry a `writeId` that joins
them to their `mount.target.writeFile` record, lie inside it, and are
contiguous, so they partition the call instead of adding to it. `versionPut`,
`namingPut` and each chunk put time one whole `Documents.put`; signing, log
append and indexing inside it are not separated. The summary script adds a
"writeFile breakdown" table (per sub-phase p50/p95 per write and share of
`writeFile` time).

The request is a live function in the write options, so the backend passes it
only to `SharedFsHandle` and the artifact-ignore wrapper while they keep their
default `writeFile` delegation (a private opt-in). Every other target,
including a third-party target that advertises the public mount write
handshake, sees exactly the unprofiled options. The summary counts sub-phase
gaps and incomplete chains (for example records dropped by a full profile
writer) and keeps those writes out of its tables. Profiling stays off by
default: an unprofiled write only checks that the internal option is absent and
reads no clock.
