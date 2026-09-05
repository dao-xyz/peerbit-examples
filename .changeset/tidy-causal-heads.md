---
"@peerbit/shared-fs": patch
---

Remove unused recursive history-depth calculations from naming and content
head resolution. Preserve head and conflict-winner ordering while avoiding
stack overflow on deep, reverse-ordered histories.
