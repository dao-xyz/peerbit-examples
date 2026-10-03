---
"@peerbit/shared-fs": patch
---

A joining peer becomes writable about a second sooner when both peers called
`peer.bootstrap()`. In that setup snapshot discovery waits out its 5 s
deadline, and the bootstrap decision used to settle just after a once-a-second
readiness check, so writes stayed blocked until the next one. The readiness
check now runs within about a tenth of a second of the decision settling. What
a join must see before it becomes writable is unchanged.
