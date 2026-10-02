---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Move to the Peerbit 5.4.9 cohort: peerbit 5.4.9, @peerbit/document 15.1.10,
@peerbit/program 6.0.67 and @peerbit/trusted-network 6.0.141 (with
@peerbit/shared-log 16.0.39, @peerbit/pubsub 5.4.12 and @peerbit/log 6.2.37).
Among its fixes, pubsub now exchanges subscriptions directly between neighbours
whether they bootstrapped or only dialled, so a peer that only dials another
replicates with it.
