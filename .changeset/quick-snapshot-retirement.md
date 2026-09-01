---
"@peerbit/shared-fs": patch
---

Retire verified cold-start snapshot overlays after the existing 300 ms removal
quiet window instead of waiting for the next five-second supersession sweep.
Fence retirement queries and timers across close and reopen generations.
