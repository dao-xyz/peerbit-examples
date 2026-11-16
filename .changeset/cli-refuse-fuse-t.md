---
"@peerbit/shared-fs-cli": minor
---

A Mac with FUSE-T but not macFUSE can no longer mount. Before, the native
adapter's cgofuse loaded FUSE-T when macFUSE was absent, and the adapter
mounted through it with `-o noattrcache`. Now `peerbit-fs mount` refuses at
once, before it looks for the adapter, opens Peerbit or waits for write
readiness, and exits 1 with one line:

```
FUSE-T is not supported: install macFUSE (brew install --cask macfuse) to mount on macOS; FUSE-T can stay installed. Found FUSE-T's /usr/local/lib/libfuse-t.dylib but not macFUSE's /usr/local/lib/libfuse.2.dylib or /usr/local/lib/libosxfuse.2.dylib.
```

`status` reports native mounts as unavailable there, with macFUSE missing and
the same text as a note. The adapter itself refuses with that text before it
connects or mounts, whichever CLI starts it. Shared-fs does not support
FUSE-T: it is licensed for non-commercial use only, and shared-fs CI does not
test it. A Mac with macFUSE, with or without FUSE-T, mounts as before. The
adapter change reaches users through this CLI version's adapter release
(`shared-fs-native-v<version>`). No wire or storage format changes.
