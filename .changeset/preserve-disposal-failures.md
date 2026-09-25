---
"@peerbit/shared-fs-cli": patch
---

Preserve both disposal-preparation and shutdown failures when they occur together. Keep the original receipt evidence as the aggregate cause, retain shutdown failure details, and never print disposal success after either failure.
