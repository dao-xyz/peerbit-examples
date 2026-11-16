---
---

Test-only: the shared-fs readiness-join test accepts a departed donor only
after it saw the joiner's connection to that donor close (until the upstream
fix is in a pinned release), and its dials get a 60 s deadline; the
cold-start hold names why it timed out. No package change.
