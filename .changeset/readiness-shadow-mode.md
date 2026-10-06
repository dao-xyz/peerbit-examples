---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Maintain proof-based write readiness state on every replica, in shadow mode.
Write readiness decisions are unchanged in this release: the existing quiet
window still decides when a joining replica may write.

This is a format break. The program variant is now `peerbit_shared_fs_v9_2`,
the entries salt is `/shared-fs/v9.2`, and the program gains a `readiness`
RPC. Filesystems created by earlier releases, including those the CLI
created, fail loudly when opened and must be recreated; shared-fs has no
production users, so no migration is kept.

- Every open replica keeps, per scope (namespace rows, and trust relations in
  access-controlled stores), the live set of entry heads from the store's
  change events, with a keyed id map, IBLT cells and an anchor digest kept by
  a worker thread.
- Every open replica answers readiness requests from peers with a snapshot of
  that state and an honest report of how it became writable. Nothing reads
  the answers yet.
- The namespace state is written to `<directory>/shared-fs-readiness/` at a
  clean close and restored at the next open; a missing, torn, foreign or
  stale file is rebuilt from the index. The trust state is rebuilt from the
  index at every open.
- `@peerbit/rpc` is now a direct dependency.
