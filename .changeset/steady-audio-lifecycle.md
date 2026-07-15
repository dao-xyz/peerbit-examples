---
"@peerbit/media-streaming-web": minor
---

Fence stale audio playback work across pause, close, and replay; serialize WAV
encoder retirement; preserve terminal chunk delivery; and retain failed
AudioContext cleanup so a later teardown can retry it. Add bounded `flush` and
terminal `finish` methods plus a reusable retryable resource drain for media UIs.
