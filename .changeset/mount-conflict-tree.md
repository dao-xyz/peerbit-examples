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
  distinct ignoring case and the same on every replica. A `content` or
  `delete-vs-edit` entry is named for its file and bytes, so a `chmod`,
  `touch` or recorded copy that keeps the bytes keeps its name.
- Every write there fails with `EROFS`: create, `mkdir`, open for writing,
  truncate, `setattr`, `symlink`, `unlink`, `rmdir`, and rename into, out of or
  within the tree, also before the mount is write-ready, where some failed
  with `EAGAIN`.
- `/` no longer lists `.peerbit-conflicts`; it is reachable by name, so git,
  backup tools and indexers do not walk hidden versions. Listing the tree
  scans every conflict, about 1 s per 10k files, the first time after a
  change that may alter it; any create, delete or rename counts. Looking up
  one entry checks that entry alone, a name no entry can have fails with
  `ENOENT` at once, and only a mount's first lookup or a well-formed name
  the last scan did not hold scans. Listing `/` or looking up the tree
  itself scans nothing.
- `SharedFileSystem` and `SharedFsHandle` gain `nodeForMount()`,
  `listNodeForMount()`, `childForMount()` and `readNodeVersionForMount()`,
  which reach a node wherever, or whether, it is named; `nodeForMount()`
  returns it as the tree shows it (`SharedFsMountNode`).
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
