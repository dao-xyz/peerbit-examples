---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Windows mounts create file and directory symlinks, and a delete-on-close file
disappears when its handle closes:

- Creating a file link from Windows (`mklink`,
  `New-Item -ItemType SymbolicLink`, `CreateSymbolicLinkW`) failed with access
  denied and left an empty file. WinFsp turns the file it has just created
  into a link by renaming a hidden symlink over it, and the mount refused to
  rename over a file it was still creating. Mount backends now give such a
  file POSIX name semantics: a rename onto it and an unlink of it succeed, and
  its descriptors keep an anonymous file that is never committed. A Windows
  delete-on-close file therefore no longer survives on the mount, and a
  temporary file that is created, unlinked, written and closed through the
  backend is never published. Linux and macOS mounts do not reach this path:
  libfuse renames a still-open file to a hidden name instead of unlinking it,
  which still answers `EAGAIN` for a pending create. An open still in flight,
  a create below the path, a pending create as a rename source and a create
  whose commit is in flight or failed (it may still have published the file)
  still answer `EAGAIN` too.
- The Windows adapter stores an absolute target on the mount relative to the
  link (`P:\a\b` linked from `P:\a\x\l` becomes `../b`), so the link resolves
  inside every peer's mount and WinFsp can read it back, which it refuses for
  absolute targets.
- A link to a directory gets the Directory attribute on Windows, so Windows
  lists through it and removes it as a directory. The adapter answers
  WinFsp's `<link>/.` probe with `ENOENT`, so WinFsp stats the link's target
  instead of the link.
- Still unsupported on Windows: targets off the mount, junctions, hard links,
  and reading a link a POSIX peer created with an absolute target.
- The hosted Windows mount smoke now gates on file and directory links, an
  absolute target, delete-on-close and no `.fuse_hidden` names left behind.

The adapter change reaches users through this CLI version's adapter release
(`shared-fs-native-v<version>`), which the release publishes automatically.
Installing the CLI fetches it; otherwise run `peerbit-fs install-adapter`.
