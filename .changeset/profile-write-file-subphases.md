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

Only targets that advertise the versioned mount write capability receive the
request; other targets see exactly the unprofiled options. Profiling stays off
by default: an unprofiled write only checks that the internal option is absent
and reads no clock.
