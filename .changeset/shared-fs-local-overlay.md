---
"@peerbit/shared-fs": minor
---

A mount can keep sealed and ignored paths on its own machine.
`openMountLocalOverlay({ directory, address, sealedNames })` opens a local
directory and `createSharedFsMountBackend(target, { localOverlay })` serves
from it every path at or below a sealed name (such as `node_modules`) or, with
an ignore-aware target, an ignored boundary: files, directories and symlinks
with ordinary POSIX behaviour, including permission bits, times, truncate,
renames inside it, unlink and rmdir. Nothing there is written to the shared
log or the block store, waited for by `persistLocalWrites()` or shown in
conflicts, and it is kept across remounts of the same directory. A shared
entry with such a name is hidden in the mount (it stays in the store), a
rename between local and shared paths fails with `EXDEV`, and a shared
directory holding local entries cannot be removed or replaced (`ENOTEMPTY`).
The mount backend gains the error codes `EXDEV`, `ENOSPC`, `EPERM` and
`EDQUOT`: a rename across an ignore boundary now fails with `EXDEV` instead
of `EACCES`, and a full or over-quota disk under the store reports `ENOSPC`
or `EDQUOT` instead of `EIO`. Without `localOverlay` a mount is otherwise
unchanged. No wire or shared storage format changes.
