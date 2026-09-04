---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Make baseline benchmark runs use reproducible unique byte corpora, measure only
filesystem I/O with high-resolution timers, and clean up only owned benchmark
paths.
