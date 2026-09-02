---
"@peerbit/shared-fs-cli": patch
---

Make unsupported native chmod, chown, and timestamp mutations fail closed, and
report the synthetic metadata and access-check contract through CLI status.
