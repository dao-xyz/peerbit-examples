---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Writer revocation: `revokeWriter(publicKey)` on the handle and `peerbit-fs revoke <address> <public-key>` remove the caller's outgoing trust edge, so de-provisioned machines lose write access as each replica's trust-graph copy converges. Built on trusted-network 6.0.101's owner-authorized revocation, which also closes the admin-grade delete hole (a trusted member can no longer remove trust edges it does not own). Revocation is not retroactive: pre-revocation documents remain, and a writer trusted through another live path stays trusted until every path is revoked (the CLI warns when that is the case).

Also upgrades the engine cohort to peerbit 5.3.34 / document 15.0.15 / shared-log 16.0.14, and re-measures the crash-then-join scenario: upstream's stale-provider rotation removes the old total-unavailability failure even without our connected-peers fetch routing, but 1 in 4 unrestricted joins still hit an ~80s delivery-timeout tail, so the routing restriction stays (consistent ~0.2-2s joins).
