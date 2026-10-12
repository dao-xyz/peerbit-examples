---
"@peerbit/shared-fs-cli": patch
---

`--assume-complete` now applies in the unverified bootstrap phase, where the
library accepts `assumeComplete()`. It is still not applied while a snapshot
overlay is fetching or active, and the wait the error and hint ask for is
now 960000 ms, since an overlay that retires unverified no longer needs about
10 more quiet minutes before the join can prove its view.
