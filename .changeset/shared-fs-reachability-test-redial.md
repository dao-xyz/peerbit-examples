---
---

Test-only: the shared-fs readiness reachability test that drops a peer's
connection dials that peer again itself, instead of relying on libp2p's one
relay reservation attempt, which the drop can prevent or cut short. No package
change.
