---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": patch
---

A joining full replica now becomes writable when it proves its view, instead
of after a quiet window. It asks every peer it can see running the filesystem
for a signed summary of that peer's namespace rows, pulls the rows it lacks,
explains the rows it will never index (superseded, older or refused), and
checks a set hash against the peer's. It turns writable once every such peer
is contained, has left, or was caught in a provable lie, at least one contained
peer answered as a write-ready full replica, and any snapshot bootstrap has
settled. The proof is persisted before the first write. There is no 5-second
floor, and a donor that writes continuously no longer keeps a joiner gated. A
donor that answered and then left still counts, where a live replicator used to
be required.

In an access-controlled store the joiner also reconciles the trust graph with
each peer, explains a revoked writer's rows only once every peer's trust graph
is reconciled, and counts a peer as a donor only if it trusts that peer's
identity. Readiness does not wait out the window in which a stale peer can
re-introduce a revoked grant.

Some joins that were released before are now held: one next to a reachable
peer that never answers, one whose only peers are not write-ready themselves
(gated joiners, observers or partial replicas), and, in an access-controlled
store, one whose only write-ready peers have identities it does not trust.
`assumeComplete()` is the operator escape: it persists source `operator` and
makes the replica writable. Readiness covers namespace rows, not chunk bytes,
so a joiner can now be writable while file contents are still replicating.
Reads fetch missing chunks from peers (`remoteChunkFetch`, on by default); with
`remoteChunkFetch: false` a read can return an older complete version or fail
with `EIO` until the chunks arrive.

- `bootstrapStatus().readiness` (`ReadinessStatus`, `ReadinessState`) names
  the peers a join waits for and why. `awaitWriteReady({ timeout })` rejects
  with `SharedFsWriteReadyTimeoutError` (`ETIMEDOUT`), whose message gives the
  reason and whose `readiness` carries the snapshot. The CLI's timeout
  messages carry that reason and advice that fits it.
- `writeReadinessSource` is `creator`, `reconciled` or `operator`;
  `remote-settled` is gone, here and in the `write-ready` telemetry event. The
  local state file stores the proof with a `reconciled` source.
- Telemetry adds `readiness-session`, one event each time an exchange contains
  a peer's scope, and removes `synchronizer-idle`; a `BootstrapTelemetryEvent`
  consumer that switches on it must drop that case.
- `drop()` now stops readiness work as `close()` does.
- `peerbit-fs create`'s error when it cannot publish the genesis manifest now
  names what the genesis is for: a joiner's snapshot bootstrap discovery.
