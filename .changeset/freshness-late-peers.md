---
"@peerbit/shared-fs": minor
---

A warm replica's freshness check now also compares with the peers that show up
after it turned fresh (M2 PR-5a), so replicas reopened at the same moment no
longer stay fresh without having compared with each other. As for a join, a
peer known only by its replicator row, with no sign of life, such as a replica
that is still opening, is asked once and stops counting if it does not answer;
`bootstrapStatus().freshness.unconfirmed` now lists such peers.

- Once fresh, the check rests: it asks nothing and arms no timer, but keeps
  listening. A sign of life from a peer that never answered it (its readiness
  subscription, any readiness message or a replication announcement) has that
  peer asked. So do the first readiness message of a peer it has not met, such
  as a replica reopened after it, and the return of a peer that left before
  answering, if it showed life since it was last asked. The state is then
  `checking`, and the replica tells peers of this release `warm` instead of
  `warm-fresh`, until that peer is contained, gone or excluded; then it is
  `fresh` again, with `freshness:change` at each change and the `WARM_FRESH`
  notices sent again. In an access-controlled store, a removal from the trust
  set has the contained peers asked again the same way.
- At rest, a peer that answered (a header, `BUSY` or a refusal) is not asked
  again; one that left with a gap is asked again if it is back when the check
  next runs, unless it closed its store. A peer that never showed a sign of
  life costs no request at rest, however its route moves. A subscription
  relayed for a dead peer that never answered, whose route lingers, counts as
  a sign of life, as while the check runs, and keeps the state at `checking`
  until that route goes.
- Under `writeReadiness.requireFreshOnReopen` the first `fresh` still releases
  the write gate; a later return to `checking` changes the label only, and the
  replica stays writable.
- `freshness.ms` is the time from the end of the open to the latest `fresh`.
  The bootstrap telemetry's `freshness` event gains an `unconfirmed` count, and
  `peerbit-fs status --json` shows `unconfirmed` with the rest of `freshness`.
