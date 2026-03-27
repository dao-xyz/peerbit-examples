---
"@peerbit/please": patch
"@peerbit/please-lib": patch
---

Wait for the full chunk set before streaming large files in observer downloads, so CLI reads do not fail after a file becomes discoverable but before all chunks are fetchable.
