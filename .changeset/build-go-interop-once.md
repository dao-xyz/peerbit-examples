---
---

Build and first launch the Go interop test binary once, in a hook with its own
budget, so a cold runner's toolchain and new-executable scan no longer count
against the Node-Go IPC interop tests. Test-only; no package change.
