---
"@peerbit/media-streaming-web": minor
---

Own media playback resources across component lifecycle changes, fence stale
asynchronous work, and preserve failed cleanup in a bounded retry registry.
Bound stalled cleanup attempts without duplicating exact closes, permit
reentrant teardown, and contain rejected asynchronous cleanup reporters.
