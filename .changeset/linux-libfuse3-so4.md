---
"@peerbit/shared-fs-cli": patch
---

Native mounts work on Linux with libfuse 3.17 or newer, such as Ubuntu 26.04
(libfuse 3.18). libfuse 3.17.1 renamed its library from `libfuse3.so.3` to
`libfuse3.so.4`, and the native adapter only looked for `libfuse3.so.3`, so
`peerbit-fs mount` failed there: the adapter exited with
`cgofuse: cannot find FUSE`. The adapter now builds against
`github.com/dao-xyz/cgofuse v1.6.0-peerbit.2`, which loads `libfuse3.so.4`
when `libfuse3.so.3` is absent (until winfsp/cgofuse#112 is released). Hosts
with libfuse 3.16 or older keep loading `libfuse3.so.3`.

The change is in the native adapter, so it reaches users through this CLI
version's adapter release (`shared-fs-native-v<version>`), which the release
publishes automatically. Installing the CLI fetches it; otherwise run
`peerbit-fs install-adapter`.
