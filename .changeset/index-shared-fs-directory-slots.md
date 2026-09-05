---
"@peerbit/shared-fs": patch
---

Index cached directory naming histories by exact entry name so warm point-path operations no longer scan unrelated directory entries while preserving complete conflict histories.

Build long same-name histories in linear time while preserving replacement and insertion ordering.
