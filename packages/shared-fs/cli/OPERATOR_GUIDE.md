# Shared FS operator guide

This guide expands the safety notes kept concise in the packaged CLI README.

Mountpoints must be exclusively owned by the CLI while mounting. The external
adapter's reserved-sentinel attachment check assumes no unrelated actor creates
paths there between preflight and attachment; it is not an adversarial TOCTOU
proof.

## Status records

`peerbit-fs status <address> --json` reports the native adapter, platform
prerequisites, write readiness, its durable source, and one-time legacy
promotion eligibility. `nativeMount.metadata` describes synthetic fixed modes
and ownership, logical timestamps, existence-only access checks, and unsupported
metadata mutations. Linux/macOS report synthetic `0755` directories and `0644`
files; Windows uses `0777` and `0666`. Creation modes are not persisted, atime
mirrors logical mtime, and OS access checks are advisory. Trusted writers remain
the authorization boundary.

Conflict metadata requires `--include-conflicts` because it scans retained
content and naming records and can dominate latency and memory on a large or
history-heavy workspace. Treat a record as an operator fence only when
`partial: false`: that requires a stable, write-ready full replica with accepted
snapshot coverage verified for the complete scan. Observer, plain-join,
fetching, overlay-active, unverified, or changing bootstrap views remain
partial. Even a verified result describes one local replica, not a global
network frontier.

## Content conflicts

`peerbit-fs conflicts` returns each file's node id, visible version id, and the
immutable heads in the local converged view, including content hash, parent ids,
author, machine, size, and creation time. Size and time use decimal strings for
safe JavaScript parsing. `snapshotCoverageVerified` only proves coverage of the
accepted signed snapshot before overlay retirement; it is not a global log
frontier. An inspection made with `--no-replicate` may be useful, but a
`fullReplica: false` result cannot prove completeness.

`resolve-conflict` writes a version referencing the selected bytes and causally
superseding the heads visible at execution. Other immutable versions remain
readable until retention and garbage collection permit reclamation. The result
reports both CLI-preflight heads and actually superseded heads so automation can
detect a corresponding race.

## Naming conflicts

The optional `naming-conflicts --path` filters output only; discovery still
rebuilds local namespace state first. Apply actions deliberately:

- `multi-head`: `keep` normally asserts the deterministic visible placement.
- `duplicate-name`: move or delete a shadowed claimant. Keeping only the visible
  winner normally leaves the collision unresolved. `merge-directory` moves the
  observed live direct children of one shadowed directory into the visible
  directory without changing node ids; child collisions remain explicit.
- `delete-vs-edit`: `restore` recovers surviving edited content, while `delete`
  acknowledges the currently visible content heads.
- `unreachable`: move the node below a reachable directory or delete it.

A move can target an occupied slot and create another duplicate-name conflict,
so inspect again after every action. Directory merge rejects a source, target,
or direct child with unresolved multiple naming heads before publishing a
partial repair. Its child moves and source tombstone are one local batch with
the tombstone last, but remote replicas may ingest the independent events in a
different order. A child first observed later beneath the deleted source appears
as `unreachable` and can be moved into the merged tree.

Resolution rejects `--no-replicate`, waits for write readiness, requires a
trusted local identity on authenticated filesystems, and rejects ids outside
the currently visible conflict. The library rechecks exact local topology and
fails retryably if it changed. Delete and restore publish only against content
heads captured before the final check, keeping later content recoverable or
concurrent. These are local observed-view fences, not global transactions; a
later event can reintroduce a conflict. Reinspect after any publication error.
Older replicas still converge because the event format is unchanged.

Neither resolution command waits for persisted remote acknowledgements. Run
`prepare-disposal` separately before retiring the resolving machine.

## Mount readiness and legacy state

The default mount waits for a settled full replica. Readable-first exposes a
possibly partial local read view after bootstrap installs an overlay or reaches
an explicit fallback, while all mutations remain gated. FUSE and macFUSE report
retryable `EAGAIN`; WinFsp reports retryable `EBUSY`. Missing paths are not
authoritative before write readiness, and applications that do not retry
write-intent errors should use the default mode.

One `--write-ready-timeout-ms` deadline covers the readable-view wait, abortable
external-adapter startup, and remaining write readiness. Timeout and termination
signals abort and join startup, detach an attached adapter, close IPC, stop the
Peerbit node, and never grant permission to write. Readable-first rejects the
in-process fuse-native fallback because that API cannot prove an abandoned
startup will not attach later.

Local `flush`, `fsync`, and close fence accepted local mutations, not remote
persisted custody. Write readiness also is not a global revocation proof:
quiesce and isolate a revoked machine, verify every serving replica rejects the
key, and retain a converged durable replica.

Pre-marker stores have no persisted readiness proof. Connection alone is
insufficient when local and remote state are already identical. Prefer a normal
namespace mutation from a connected complete replica. Use
`trust-legacy-replica --assume-local-replica-complete` only when status reports
eligibility and an operator independently verified the directory was a cleanly
shut down, complete full replica never copied during bootstrap. Its marker is
directory- and address-specific and must never be copied. The partial-write
option is a session-only recovery bypass: it can create duplicate paths or
overwrite stale data and leaves snapshot, GC, ACL, and disposal operations
blocked.

## Machine disposal

Stop the original mount process and wait for its clean exit before running
`prepare-disposal`; `unmount` alone only detaches the OS path. A timeout, abort,
error, or nonzero exit never indicates safe disposal. Keep the source state,
repair connectivity or capacity, allow bootstrap and guards to settle, and retry
against the existing full local replica.

The recoverable closure includes current naming heads (including tombstones and
conflicts), current file-version heads and referenced chunks, and surviving
trusted-writer grants and revocation tombstones. It excludes superseded history
and control manifests. The receipt is per entry: each exact entry reached the
requested number of capable durable remote leaders, but one common custodian is
not guaranteed. The command does not raise replication; older, incapable,
in-memory, and local peers do not count.

Receipts describe one instant on cooperative remotes. They are not permanent
custody, Byzantine, or literal power-cut proofs. An empty closure is vacuous and
does not prove a remote peer existed. Disposal does not revoke the local writer;
perform and converge intended revocation first. The automated crash campaign
verifies forced application-process termination on the default disk backend,
not arbitrary storage or controller-cache semantics.
