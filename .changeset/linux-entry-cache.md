---
"@peerbit/shared-fs-cli": patch
---

Make path lookups on Linux mounts cheaper. cgofuse v1.6.0 cleared libfuse's
configuration when a FUSE 3 mount started, so the kernel cached nothing and
every `lstat` cost one adapter round trip per path component plus one. The
native adapter now builds against a cgofuse fork without that line
(`github.com/dao-xyz/cgofuse v1.6.0-peerbit.1`, until winfsp/cgofuse#110 is
released) and mounts Linux with
`-o entry_timeout=0.1,attr_timeout=0,negative_timeout=0`: the kernel caches
which file a name leads to for at most 0.1 s, and never caches attributes or
missing names. A stat of a two-component path repeated within 0.1 s of the
path's last lookup costs one adapter callback instead of three; once the
cached names expire, the next stat again costs one per path component plus
one. On a GitHub Linux runner, `git status` of a 2,000-file tree fell from
2.91 s to 1.23 s and `git clone` from 35.6 s to 27.0 s.

Other peers' edits, deletes and renames still appear with no added delay.
For up to 0.1 s after another peer changes a path's type (file, directory or
symlink), calls that use the old cached name can fail. A stat fails once with
`EIO` and the next call is correct (measured for a file replaced by a
directory). Opening the name, following it as a link or walking a path
through it can fail with `ENOTDIR`, `EISDIR` or `EINVAL` on every try until
the cached name expires (not measured). On Linux the adapter's `Open` now
answers `ESTALE` where the daemon reports a missing path, so the kernel
retries with a fresh lookup and creating a file right after another peer
deleted it succeeds. macOS and Windows are unchanged.

The change is in the native adapter, so it reaches users through this CLI
version's adapter release (`shared-fs-native-v<version>`), which the release
publishes automatically. Installing the CLI fetches it; otherwise run
`peerbit-fs install-adapter`.
