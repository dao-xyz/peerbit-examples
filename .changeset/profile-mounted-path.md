---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Add opt-in mounted-path profiling across native callbacks, serialized IPC queue
and round trips, Node backend service, local fsync fences, and the exact
Peerbit-facing write call, with no clock reads or event allocation when disabled.
