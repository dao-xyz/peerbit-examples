---
"@peerbit/shared-fs": patch
---

A joining full replica no longer waits for snapshot discovery to time out once
write readiness has proved its view. When every peer it must account for is
contained, with one write-ready donor, while its snapshot bootstrap is still
looking for or fetching a snapshot, the bootstrap stops: no snapshot from those
peers could add a row. The join falls back to a plain join (`lastFailure` and
the `fallback` telemetry reason: "readiness proved the view before a snapshot
was needed"), `awaitBootstrapConverged()` resolves `{ verified: false }`, and
the replica turns writable on the next readiness evaluation. Before, a joiner
connected to a peer that does not run the filesystem, such as a relay that
`peer.bootstrap()` dials, waited the whole `discoveryTimeoutMs` (5 s by
default) whenever no peer served a usable snapshot: a never-written or young
filesystem, or one whose snapshots were stale or from untrusted signers.

`manifest-discovery:end` reports `aborted: "readiness"` when this ends
discovery or the wait for a trusted signer. A snapshot overlay already in use
is not stopped. A bootstrap stopped before it accepted a snapshot manifest still
takes the advisory ignore patterns of the manifest a full bootstrap would have
chosen (the newest usable one from a trusted signer), so a fleet with no
`/.artifactignore` passes its ignore rules on to such a joiner. Readiness does
not wait for snapshot manifests: one the joiner holds by then is taken at once,
and until the ignore policy has found the rules file or settled without it, a
manifest arriving later, or one whose signer becomes trusted later, is taken
when it arrives. Until then the policy does not conclude that the rules file is
absent, and write readiness never waits for it. The joiner never takes its own
manifest, and while it waits it advertises no patterns of its own: its
automatic snapshot publication waits for the answer, and a `snapshotWrite()`
without `advisoryIgnorePatterns` carries none. Only a handle opened with an
`ignore` policy that reads the defaults file and merges into it waits this
way. An ignore policy also no longer concludes the rules file absent while
the open's bootstrap has yet to decide whether to fetch a snapshot, so a full
bootstrap's manifest accepted after that still applies its patterns. Patterns
taken late apply as when a full bootstrap accepts its manifest after the handle
opened: new writes under ignored paths are rejected, and files already written
there stay in the shared store, hidden from `list()` by default.
`mode: "require"` is unchanged: it still waits for a snapshot and fails when
none is usable. A store resuming an interrupted bootstrap that is stopped this
way keeps its crash marker until the readiness proof is written, so a crash in
between reopens gated, as before.
