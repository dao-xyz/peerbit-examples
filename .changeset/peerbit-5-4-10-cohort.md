---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Move to the Peerbit 5.4.10 cohort: peerbit 5.4.10, @peerbit/document 15.1.11,
@peerbit/program 6.0.68 and @peerbit/trusted-network 6.0.142 (with
@peerbit/shared-log 16.0.40, @peerbit/log 6.2.38 and @peerbit/pubsub 5.4.13).
It recovers interrupted replication and drains cancelled joins, and releases a
failed replay's resources.
