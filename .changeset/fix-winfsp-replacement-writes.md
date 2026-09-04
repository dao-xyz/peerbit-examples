---
"@peerbit/shared-fs-cli": patch
---

Report the mounting account as the synthetic WinFsp owner so Windows
replacement writes, including Node open with truncation, receive the extended
attribute access required by CreateFileW.
