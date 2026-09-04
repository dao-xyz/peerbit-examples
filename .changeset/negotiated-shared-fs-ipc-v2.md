---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Negotiate binary IPC v2 with the native Go adapter so read and write payloads use bounded raw frame bodies while preserving JSONL v1 compatibility and fail-closed no-replay semantics. Publish matching rebuilt native adapter binaries with the CLI patch.
