---
"@peerbit/shared-fs": minor
---

FUSE-T no longer counts as a macOS mount runtime. On a Mac with FUSE-T but
not macFUSE, `getNativeMountSupport()` now reports native mounts as
unavailable, with `macFUSE` missing and a note that FUSE-T is not supported,
how to install macFUSE and which libraries it checked; before, it reported
them as available and noted that mounts would use FUSE-T. The new
`getNativeMountRefusal()` returns that note on such a Mac and `undefined`
everywhere else, so a caller can refuse before it opens a filesystem; the
native adapter refuses there with the same text. Shared-fs does not support
FUSE-T: it is licensed for non-commercial use only, and shared-fs CI does not
test it. A Mac with macFUSE, with or without FUSE-T, is unchanged. No wire or
storage format changes.
