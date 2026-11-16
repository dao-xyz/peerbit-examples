---
"@peerbit/shared-fs": patch
---

A joining replica of an access-controlled filesystem no longer turns writable
without the files of a writer whose grant left its trust graph during the join
while a peer still held that grant. When a writer is revoked and later granted
again, the owner's old revocation can reach a joiner while the new grant is
still being indexed, and then removes the new grant from the joiner's trust
graph again. Before, a peer's trust view checked against the joiner's trust
graph before that removal still counted afterwards: the joiner explained the
writer's rows as untrusted and turned writable without them, so it accepted
writes on a view that lacked that writer's files.

Now a trust check made before any removal from the joiner's trust graph no
longer counts. The joiner checks that peer again, in the same session when the
check had not finished yet, or by asking the peer again, and the writer's rows
stay pending. Such a joiner now stays gated instead (not writable;
`awaitWriteReady` keeps waiting, and `bootstrapStatus().readiness` reports it
waiting) for as long as its trust graph lacks a grant its peers hold;
`assumeComplete()` still releases it. The readiness coordinator's debug output
records the last removal (`trustRemovedAt`) and counts the checks asked again
(`staleTrust`).

A join also no longer stalls when a change to the joiner's trust graph, or a
peer's trust check completing, arrives just as its check of a peer's waiting
rows ends: the check now runs again instead of leaving those rows waiting with
nothing scheduled.
