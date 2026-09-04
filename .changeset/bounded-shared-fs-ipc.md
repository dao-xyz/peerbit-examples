---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Bound native-mount JSONL request and response frames, process each adapter
connection serially with write backpressure, and isolate malformed clients.
The CLI patch publishes matching rebuilt native adapter binaries.
