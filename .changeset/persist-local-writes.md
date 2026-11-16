---
"@peerbit/shared-fs": minor
---

`persistLocalWrites({ minAcks = 1, timeout, signal })` awaits remote receipts
for every entry this replica wrote since it opened (its naming events,
versions and changeset manifests, and the chunks those versions reference)
and for the naming heads their paths resolve through, an earlier session's
included, on `prepareForDisposal`'s receipt path. It runs until none is left,
so entries written while it runs are fenced too. Unlike that whole-store
fence, other writers' arrivals do not fail it, an entry deleted under it (GC)
starts it over, and an entry acknowledged once is not sent again (a naming
head a later write resolves through is). With a timeout it waits for a
replica to join until the deadline. It fails with `PersistLocalWritesError`,
whose `unacknowledged` lists ids and paths. `pendingLocalWrites()` reports
what is left and whether another replica joined in this session. The mount
backend gains `drain()`, which releases every open descriptor as a close
would. The ledger is in memory: the files of an earlier session that crashed
are not covered. The snapshot manifest is maintenance and is not fenced.
