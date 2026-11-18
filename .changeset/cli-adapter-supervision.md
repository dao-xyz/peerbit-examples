---
"@peerbit/shared-fs-cli": minor
---

The native adapter now ends with `peerbit-fs mount`, and a mount that a killed
adapter left behind no longer blocks the next one:

- An adapter whose `mount` dies, even by `kill -9`, unmounts and exits: it
  holds a second IPC connection to `mount` and stops when that closes. On
  Windows, Node already ends the adapter with `mount`, and WinFsp removes the
  drive.
- A mountpoint left disconnected by a killed adapter, which fails with
  `Transport endpoint is not connected` on Linux, no longer blocks the next
  mount: the next adapter there unmounts it first, but only when the mount
  table shows a mount that a peerbit-fs adapter of the same user left;
  otherwise it refuses and names the command to run. Mounts are now listed
  with source `peerbit-shared-fs` (on Linux, type `fuse.peerbit-shared-fs`),
  so a disconnected mount that an earlier adapter release left is not
  recognized: unmount it by hand.

The adapter changes reach users through this CLI version's adapter release
(`shared-fs-native-v<version>`). No wire or storage format changes.
