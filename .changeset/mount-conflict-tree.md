---
"@peerbit/shared-fs": minor
---

A native mount now shows every conflict under `/.peerbit-conflicts`, naming
conflicts included, as read-only files and directories that ordinary tools can
read and copy. Before, it showed content conflicts only, as
`/.peerbit-conflicts/<encoded path>/<version id>`: a version id holds `:`,
which no Windows name can, and an encoded path could pass 255 bytes.

- The tree is flat, one entry per hidden version or node, named
  `<kind> <path> <writer> <time> <hash>[.<ext>]` (see the README's
  "Conflicts"). `content` entries are the distinct heads of a file in
  conflict and `delete-vs-edit` entries the versions a delete did not see;
  `duplicate-name` entries are shadowed claimants, `multi-head` entries nodes
  whose concurrent renames disagree, and `unreachable` entries the top-most
  nodes whose parents no longer reach `/`, a directory browsable with its
  files. Names are valid on Windows, macOS and Linux, at most 160 bytes,
  distinct ignoring case and the same on every replica.
- Every write there fails with `EROFS`: create, `mkdir`, open for writing,
  truncate, `setattr`, `symlink`, `unlink`, `rmdir`, and rename into, out of or
  within the tree, also before the mount is write-ready, where some failed
  with `EAGAIN`.
- `/` no longer lists `.peerbit-conflicts`; it is reachable by name, so git,
  backup tools and indexers do not walk hidden versions. The tree is scanned
  on its first read after a change that may alter it; listing `/` or looking
  up the tree itself scans nothing.
- `SharedFileSystem` and `SharedFsHandle` gain `nodeForMount()`,
  `listNodeForMount()`, `childForMount()` and `readNodeVersionForMount()`,
  which reach a node wherever, or whether, it is named.
  `SharedFsMountBackendTarget` gains them and `namingConflicts()` as optional
  members; a target without them shows content conflicts only. An
  `unreachable` naming conflict carries the node's `parentId`, and the
  namespace feed sets `versionForkOrMerge` when a version lands on a node
  whose name is deleted or not yet known (a delete-vs-edit).
  `conflictEntryNames()` builds the entry names; `encodeConflictPathName()`
  and `decodeConflictPathName()` are removed.

The stored format and the wire are unchanged. The new layout replaces the old
one without a compatibility window, a break allowed because shared-fs has no
production users.
