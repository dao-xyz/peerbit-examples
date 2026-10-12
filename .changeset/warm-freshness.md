---
"@peerbit/shared-fs": minor
---

A warm reopen now checks whether it is still fresh (M2 freshness, labels only).
At the end of a warm full-replica open, the replica runs the join's readiness
exchange with every peer of the filesystem it can see, with no write-readiness
decision: it is fresh once every visible peer is contained, gone or excluded,
at least one is contained and, with access control, the trust rules hold. No
qualified donor is needed, so two warm replicas reopened together check each
other; a peer that left before answering is recorded in `freshness.gaps`, as a
join records it. The check runs once per open, arms no timer and asks nothing
again once it held; only the state file's `hlcProved` hint is updated. The warm
replica stays writable throughout: no joiner's decision changes, and `warm`
still qualifies a donor.

- `bootstrapStatus().freshness` (`FreshnessStatus`, `FreshnessState`) reports
  the check on a warm full-replica open, and `freshness:change` is dispatched
  on `fs.program.events` at each state change. The bootstrap telemetry gains a
  `freshness` event with the state, the peer counts, `ms` and the requests the
  check sent. `bootstrapStatus().readiness` stays undefined on a warm reopen.
- New option `writeReadiness: { requireFreshOnReopen: true }`: a warm reopen
  stays write-gated (`EAGAIN`, resurrection guard armed) until its check holds,
  then turns writable with the source and proof its state file already holds,
  and dispatches `write:ready`. Offline it stays gated, and so it does while a
  visible peer stays silent or answered `BUSY` with no message or capacity
  notice since (a refusal on a fault of that peer's own readiness state);
  `assumeComplete()` releases it as `operator`. It is refused with
  `allowPartialWrites`.
- Once fresh, a replica tells askers of this release `warm-fresh` instead of
  `warm` and sends each peer it exchanged requests with a `WARM_FRESH` notice.
  A joiner now advertises readiness caps bit 0 (`CAP_FRESHNESS`) in its OPEN
  and counts a `warm-fresh` donor as qualified, as it counts `warm`. No wire
  layout, store salt or format tag changes: 0.17.x already decodes the bit, the
  source and the notice reason.

A mixed 0.17.x / this-release pair behaves as before. A 0.17.x joiner never sets
the bit, so a warm donor of this release answers it `warm`, which it qualifies,
and labels its notices to it `warm` as well: a 0.17.x joiner that met a
`requireFreshOnReopen` replica while it was gated qualifies it on the notice of
its flip, and a `WARM_FRESH` notice changes none of its records.
A joiner of this release still qualifies a 0.17.x warm donor through `warm`. A
0.17.x warm replica runs no check and never reports `warm-fresh`; a warm replica
of this release checks against it like any other peer, and a 0.17.x joiner
answers that check as it answers a join.
