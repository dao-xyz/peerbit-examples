---
"@peerbit/shared-fs": minor
---

`persistLocalWrites({ minAcks = 1, timeout, signal })` awaits remote receipts
for every entry this replica wrote since it opened (its naming events,
versions and manifests, and the chunks those versions reference), on
`prepareForDisposal`'s receipt path. Unlike that whole-store fence, other
writers' arrivals do not fail it, and an entry acknowledged once is not sent
again. With a timeout it waits for a replica to join until the deadline. It
fails with `PersistLocalWritesError`, whose `unacknowledged` lists ids and
paths. `pendingLocalWrites()` reports what is left and whether another replica
joined in this session. The mount backend gains `drain()`, which releases every
open descriptor as a close would. The ledger is in memory: writes of an
earlier session that crashed are not covered.
