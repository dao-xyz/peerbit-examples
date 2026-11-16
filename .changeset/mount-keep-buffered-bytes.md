---
"@peerbit/shared-fs": patch
---

A native mount no longer drops what was written through an open file when
another machine renames, replaces or deletes that file before the bytes are
saved. The mount discarded the buffered bytes of such a descriptor while
`flush`, `fsync` and close reported success, or failed the save with `EAGAIN`
and closed the descriptor. Now the save goes to the same file node: after a
rename the bytes land at the file's new path, and after a delete or replace
the delete stays visible and the save is a `delete-vs-edit` naming conflict,
as for `writeFile`. A naming-conflict `move` brings it back (and lists both
versions as a content conflict if the other side had also edited the file);
`restore` brings it back only at its old path. The fence succeeds only once
that save is committed and fails with an error otherwise, keeping the bytes.
The stored format and the wire are unchanged.

- This mount's own `unlink`, or a rename over the open file, still leaves the
  descriptors whose writes that path showed an anonymous file that is never
  saved, as in POSIX. An older descriptor of the same file, whose bytes that
  path never showed because another machine had moved the file, still saves
  them, as a `delete-vs-edit`.
- When the version an open file builds on is unavailable (not yet replicated,
  or retired), its fence now fails with `EIO` and the descriptor keeps its
  path and bytes, instead of being treated as a path change.
- `SharedFileSystem.writeNodeForMount()` and
  `SharedFsHandle.writeNodeForMount()` write to a file node wherever it is
  named now; an optional `guard` vets that path first.
  `SharedFsMountBackendTarget` gains it as an optional member. On a custom
  target without it, such a save fails with `EIO` and keeps the bytes.
  `IgnoreAwareFs` applies its write policy to both the path the mount last
  saw and the path the save lands at.
- Not covered yet: a new file the mount has never saved. If another machine
  renames, removes or replaces a directory on its path before the first save,
  that save still fails and the bytes are lost.
