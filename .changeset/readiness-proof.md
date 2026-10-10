---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": patch
---

A joining replica now also proves that it holds every row its visible
peers hold before it becomes writable. Each peer answers with a compact
summary of its rows; the joiner pulls what it lacks, explains rows it
cannot hold (superseded, older or refused), and checks a set hash against
the peer's. The existing quiet window still applies, so a join is never
released earlier than before, but some joiners are now held that were
released before: one whose only peers are not write-ready themselves, and
one next to a reachable peer that never answers. In an access-controlled
store the joiner also reconciles the trust graph with each peer, explains a
revoked writer's rows once every trust graph is reconciled, and counts a
peer as a donor only if it trusts that peer's identity. `assumeComplete()`
is the operator escape. `bootstrapStatus().readiness` and the `ETIMEDOUT` error
(`SharedFsWriteReadyTimeoutError`) name the peers a joiner is waiting for,
and the CLI's timeout messages carry that reason. `drop()` now stops the
write-readiness tracker and its timers, as `close()` does.
