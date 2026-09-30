---
---

Pin the cold-start stall with a snapshot document that can never arrive, cover
the retirement timeout with its own timer-ordered test instead of a donor stop
and a rebuild loop, and seed the deep GC history as version rows instead of
6,000 writes. Test-only; no package change.
