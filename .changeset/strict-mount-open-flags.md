---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Correct shared mount-backend flag handling and the external cgofuse adapter on Linux, macOS, and WinFsp: enforce descriptor access, require explicit creation, bind nested creates to the exact parent directory node, honor append and exclusive flags, materialize read-only creates, reject read-only truncation, forward cgofuse callback flags, preserve existing files during Mknod and the conservative fuse-native create shim, atomically identify expected-node and create-parent fence losses, serialize overlapping local creates and namespace transitions, and prevent buffered creates from resurrecting paths across mkdir, remove, or either side of rename. Failed one-shot Mknod releases now discard their unreachable local reservation while normal handles retain retryable buffered data. The fuse-native create callback does not expose the caller's flags and retains the documented conservative limitation; WinFsp translates Windows create semantics before the cgofuse callback.
