---
"@peerbit/shared-fs": patch
---

Snapshot manifest discovery asks only the peers that run the filesystem: the
subscribers of its readiness topic and the replicators of its namespace log,
each while reachable. Connected peers that do not run it, such as the relays
`peer.bootstrap()` dials, are no longer asked, so a joiner beside them no
longer waits `discoveryTimeoutMs` (5 s by default) for an answer that never
comes once the filesystem's peers have answered. Discovery ends when every peer
asked has answered, or once a usable manifest has arrived and every readiness
subscriber has answered. A replicator that never subscribed the readiness topic
is still asked, but its row can outlive the peer, so it no longer holds
discovery after a usable manifest, nor once every readiness subscriber asked
has returned a manifest (a zero-document one counts). A pending peer is asked
again when it announces itself as a replicator, and every still-silent peer at
half the deadline, as before.

In mode `"require"`, answers with nothing no longer end discovery while no
manifest has been found: a donor that becomes visible later is still asked,
until `discoveryTimeoutMs`.

A snapshot whose signer is not trusted yet is checked again on each
trust-graph change instead of every 250 ms, until the same deadline as before.

`manifest-discovery:end.targets` counts the peers asked, which no longer
include up to 16 other direct neighbours. A donor visible neither as a
readiness subscriber nor as a replicator is no longer found, nor one visible
only as a replicator once every readiness subscriber returned a manifest; such
a joiner replicates the log instead (the plain-join fallback), and in mode
`"require"` the open fails, as before when discovery missed a donor.
