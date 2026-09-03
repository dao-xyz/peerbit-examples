---
"@peerbit/shared-fs": patch
---

Schedule joined-replica write-readiness checks directly on the required quiet
deadline, then revalidate after the minimum independent-check gap. This removes
up to two seconds of timer quantization without shortening the five-second
settled-view window or weakening remote-replica, synchronizer-idle, durable
marker, cancellation, and lifecycle checks.
