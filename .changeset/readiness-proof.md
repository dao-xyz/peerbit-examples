---
"@peerbit/shared-fs": minor
---

A joining replica becomes writable once it proves that it holds every row
its visible peers hold, instead of after a quiet window with no arrivals.
Each peer answers with a compact summary of its rows. The joiner pulls
what it lacks, explains rows it cannot hold (superseded, older or
refused), and checks a set hash against the peer's. A direct join becomes
writable in well under a second, and a join next to a peer that keeps
writing no longer waits for a pause that never comes. A peer that is
reachable but never answers now keeps a joiner gated until its timeout;
`assumeComplete()` is the operator escape, and `bootstrapStatus()` and the
`ETIMEDOUT` error name the peers it is waiting for.
