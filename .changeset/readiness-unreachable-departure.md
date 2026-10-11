---
"@peerbit/shared-fs": patch
---

A joining replica no longer waits forever for a peer it cannot reach. A
replica that reopens without a write-readiness proof can still hear about a
stopped peer through other peers: pubsub relays the stopped peer's
subscription, and the replication index then announces it as a replicator.
Each of these counts as a sign of life, so the replica kept asking the stopped
peer, and `awaitWriteReady()` timed out naming it ("1 of 1 required peer in
flight"). When no network event followed, the replica never became writable.

The replica now checks whether it can reach a peer whenever that peer starts
or keeps blocking it: when it is first listed, when it shows a sign of life,
when the replication index says it left, and when each request attempt ends.
This check is the same one a network event triggers. A peer the replica cannot
reach is treated as gone, as on a disconnect, and is recorded as a gap in
`bootstrapStatus().readiness.gaps` and in the proof. Replicators that are still
reachable and announce themselves still count and are waited for, and so is a
peer that is still answering. A gone peer that becomes reachable again is
asked again. A peer that goes silent is checked too and leaves if the replica
cannot reach it, so `readiness-peer` reports a silent peer only as
`reachable-silent`.
