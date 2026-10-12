---
---

Give the shared-fs large-reopen-scans test a 300 s budget: on Windows
runners its 300-file write takes 46-89 s (about 2 s on Linux), the same on
0.16.6, so the default 120 s timed it out. Test-only; no package change.
