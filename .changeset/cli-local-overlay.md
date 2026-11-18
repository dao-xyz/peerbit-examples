---
"@peerbit/shared-fs-cli": minor
---

`mount` keeps `node_modules` (the filesystem's sealed names) on this machine,
so `npm ci` and `npm install` work in a mount. Before, creating
`node_modules` failed with a permission error. The local entries live under
the state directory in `shared-fs-local-overlay/<id>`, printed at mount as
`Local overlay: <dir>`; they survive remounts and are never sent to other
replicas or waited for by `--persist-on-exit`. A mount with `--directory ""`
(in-memory state) uses a temporary directory that is removed when the mount
stops. Moving a file between `node_modules` and the rest of the mount fails
with `EXDEV`, which `mv` and file managers handle by copying, and a shared
file or symlink named `node_modules` is no longer shown in a mount. The
native adapter now reports `EXDEV`, `ENOSPC`, `EPERM` and `EDQUOT` (`ENOSPC`
on Windows) instead of `EIO`; this reaches users through this CLI version's
adapter release (`shared-fs-native-v<version>`), and an older adapter still
reports them as `EIO`. No wire or shared storage format changes.
