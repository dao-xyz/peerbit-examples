---
"@peerbit/shared-fs": patch
---

A joining peer no longer spends about 15 s looking for a snapshot when it is
also connected to peers that do not run the filesystem, such as the public
relays `peer.bootstrap()` dials. Those peers never answer, and the snapshot
query waited 5 s for them three times. The query now asks each peer
separately, with one deadline (`discoveryTimeoutMs`, 5 s by default) and one
repeat at half of it:

- When a peer has served a usable snapshot, discovery ends as soon as the
  peers visible as running the filesystem have answered. In the tests that
  takes tens of milliseconds.
- When no usable snapshot has arrived, discovery waits for every connected
  peer until the deadline, once. A peer that never answers cannot be told
  apart from a donor whose answer is still on its way, so an empty answer
  from one peer does not end the wait for another. An address-open that sees
  no peer running the filesystem now also waits up to `discoveryTimeoutMs`
  for one before it falls back, instead of falling back at once.

Connected peers are asked before they show up as filesystem peers, so a
connected donor whose subscription has not arrived yet is still found if it
answers before the deadline. A donor that is neither connected directly nor
visible yet can still be missed. The joiner then replicates normally, without
the snapshot speed-up.

Copies of a manifest served by several peers are now checked one by one, so a
corrupted copy no longer hides the genuine one. Each author's newest manifest
counts once in `candidates`.

The `manifest-discovery:end` telemetry event gains `targets` (peers asked)
and `zeroDocument`. A creator's genesis manifest, published before anything
was written, installs nothing and was reported only as "0 candidates". It is
now counted in `zeroDocument`.
