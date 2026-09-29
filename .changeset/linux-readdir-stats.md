---
"@peerbit/shared-fs-cli": patch
---

Stop sending per-entry stats with directory listings on Linux mounts. The
native adapter asked the daemon for every entry's stats and enabled
readdir-plus, but libfuse 3.14's high-level API passes those stats to the
kernel with node ID 0, which tells the kernel to ignore them: a `stat` of each
listed file cost the same adapter callbacks with or without them. libfuse
also kept a lookup reference for every listed entry that the kernel never
released. Linux now requests compact listings, as macOS already did, and
passes the kernel only each entry's type. A 128-file listing is 4.9 KB over
IPC instead of 16.4 KB, and its round trip took 0.28 ms instead of 0.50 ms in
a local measurement. Entries still report their type (`d_type`), so
`readdir` with file types needs no extra `stat`. macOS listings now report
each entry's type too, where they reported an unknown type before. Windows
is unchanged: WinFsp uses the stats.

The change is in the native adapter, so it reaches users through this CLI
version's adapter release (`shared-fs-native-v<version>`), which the release
publishes automatically. Installing the CLI fetches it; otherwise run
`peerbit-fs install-adapter`.
