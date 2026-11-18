---
"@peerbit/shared-fs-cli": patch
---

On Windows, `mount` could print `Mounted` before its drive letter existed, so
a command started on that line, such as `mkdir P:\app`, failed with `ENOENT`.
WinFsp calls the native adapter's init before it defines the letter, and the
adapter reported ready from init. It now reports ready once the letter is
defined: it hears the arrival Windows broadcasts for the letter and checks it
with `QueryDosDeviceW`, and it stops waiting after 10 s. A directory
mountpoint on Windows is not waited for. The fix reaches users through this
CLI version's adapter release (`shared-fs-native-v<version>`). The README's
Windows example now mounts at a drive letter: it created the mount directory
first, which WinFsp refuses.
