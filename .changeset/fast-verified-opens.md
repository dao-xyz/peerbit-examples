---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Reuse SharedFileSystem's target-verified exact-version snapshot when opening an existing file for native-mount writes, removing the mount's duplicate whole-file SHA-256 pass without changing chunk or whole-file verification. Custom mount targets retain the legacy local-hash fallback unless they explicitly implement the versioned verified-read capability.
