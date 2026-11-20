---
"@peerbit/shared-fs-cli": minor
---

`peerbit-fs mount` and its native adapter now end together, so a supervisor
such as systemd or launchd only has to watch `mount`:

- An adapter that exits on its own after the mount is up (a crash, `kill -9`,
  the out-of-memory killer) is reported with its exit code or signal and its
  last 20 stderr lines, and the mount stops as on a first shutdown request:
  open files are saved and persist-on-exit runs. `mount` then exits 70; a
  failed step's 1 is kept over 70, and 70 over 75 and 130. Before, `mount`
  kept running behind a dead mount.
- On Linux and macOS that stop first unmounts the disconnected mount the
  killed adapter left, which failed with `Transport endpoint is not connected`
  on Linux, but only when the mount table shows a mount that a peerbit-fs
  adapter of the same user left; otherwise `mount` exits 1 and names the
  command to run. If both processes were killed, the next adapter at that
  mountpoint makes the same check and unmounts it before mounting. Mounts are
  now listed with source `peerbit-shared-fs` (on Linux, type
  `fuse.peerbit-shared-fs`), so a disconnected mount that an earlier adapter
  release left is not recognized: unmount it by hand.
- An adapter stopped from outside (`peerbit-fs unmount`, `fusermount -u`,
  `umount`) exits 0, and the mount stops the same way, with exit code 0.
  `peerbit-fs unmount` no longer leaves its `mount` process running.
- An adapter whose `mount` dies, even by `kill -9`, unmounts and exits: it
  holds a second IPC connection to `mount` and stops when that closes, and on
  Linux the kernel also sends it SIGHUP when its parent exits (a wrapper
  script given as `--native-adapter` should start it with `exec`). On Windows,
  Node already ends the adapter with `mount`, and WinFsp removes the drive.
- `mount` exits as soon as its stop is done, about a second sooner than
  before, and a shutdown request that comes after the stop exits at once with
  the exit code already set. A stop step that failed (the others still run)
  is printed as one line before `mount` exits 1, instead of the `mount` help
  and a stack trace.

The adapter changes reach users through this CLI version's adapter release
(`shared-fs-native-v<version>`). No wire or storage format changes.
