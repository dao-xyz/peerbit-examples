---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

macOS native mounts:

- The adapter reports ready, and `peerbit-fs mount` prints `Mounted`, only once
  the mountpoint is attached. It waits for the kernel's mount event (kqueue
  `EVFILT_FS`) and checks the mount table, without polling. A FUSE runtime that
  calls Init before macOS attaches the mount (FUSE-T does) could otherwise let a
  write right after `Mounted` land in the bare mountpoint directory.
- `getNativeMountSupport` and `peerbit-fs status` look for the FUSE library the
  adapter will load, in cgofuse's order, instead of only the macFUSE bundle.
  When macFUSE is absent and FUSE-T is installed, the adapter falls back to
  FUSE-T; status now says so and that shared-fs does not test FUSE-T, and the
  adapter mounts it with `-o noattrcache` so the macOS NFS client's attribute
  cache does not hide other peers' changes.
