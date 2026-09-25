---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Upgrade Shared FS to the coherent Peerbit persisted-readiness and cold-open
cohort. Forward advisory SharedLog open/profile spans through the existing
telemetry surface, migrate durability tests to the public exact-entry readiness
waiter, and require caller-exclusive upstream block-store safety metadata in
addition to the Shared FS ownership assertion before physical snapshot segment
reclamation.
