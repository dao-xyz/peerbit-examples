---
"@peerbit/shared-fs": patch
---

Adopt the coherent published Peerbit 5.4.6 cohort: Documents 15.1.7, Shared
Log 16.0.36, Program 6.0.64, Trusted Network 6.0.138, RPC 6.2.0 and PubSub
5.4.9. Since the 5.3.35 cohort this brings upstream indexed-query policy
compatibility, cooperative receive shutdown, subscription lifecycle and routing
fixes, stopped pubsub idle timers, and opt-in persisted-delivery, query and RPC
diagnostics. The shared-fs storage format, replication policy, writer
authorization and persisted-disposal acceptance requirements are unchanged.
