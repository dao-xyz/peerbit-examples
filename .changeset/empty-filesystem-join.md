---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Let a peer that opens a never-written filesystem by address become
write-ready. Readiness needs positive evidence that log sync started, and
until now only replicated namespace metadata (or a snapshot found by
discovery) counted. A filesystem nobody has written has no metadata, so a
joiner of a freshly created one stayed read-only, and
`peerbit-fs mount <address>` failed after 120 s with "did not establish a
safe initial write view".

- Creating a filesystem now publishes a signed zero-document genesis
  manifest when the creator is a trusted full replica, automatic snapshots
  are enabled and the log is empty. `peerbit-fs create` no longer publishes
  its own; the library does it for every creator.
  `snapshot: { disabled: true }` skips it.
- A replicated snapshot manifest now counts as readiness evidence, like
  replicated metadata. A gated joiner cannot publish one, so it came from
  another peer.
- A zero-document manifest is no longer a bootstrap candidate. It installs
  nothing, and its overlay retired at once, counting as verified coverage
  and readiness evidence without covering any log entry, though a genesis
  can be older than the data. Such joiners now plain-join, where the
  manifest's replication is the evidence. Snapshots with documents are
  unchanged. This also stops a reopen of an empty filesystem from briefly
  rejecting `prepareForDisposal` while it "bootstrapped" from its own
  genesis.
- `snapshotWrite` replaces the previous manifest with one put that CUTs its
  head, instead of a delete followed by a put. A joiner that never held the
  old manifest could keep the delete entry pending in its sync and never
  become write-ready. In a local repro this hit about half of the joins to
  any filesystem whose author had published twice.

The rest of the gate is unchanged: a settled bootstrap, a connected
replicator, an idle synchronizer and the quiet window. A joiner that reaches
no replicator stays closed. There is no format change: the genesis is an
ordinary bootstrap manifest and the replacement an ordinary put.
