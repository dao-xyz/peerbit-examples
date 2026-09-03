---
"@peerbit/shared-fs-cli": patch
---

Lazily load the Shared FS runtime so CLI help, parser errors, and native adapter
installation avoid initializing the full Peerbit stack.
