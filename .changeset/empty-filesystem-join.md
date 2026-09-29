---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Let a peer that opens a never-written filesystem by address become
write-ready. Readiness needs positive evidence that log sync started, and
until now only replicated namespace metadata (or a snapshot found by
discovery) counted. A filesystem nobody has written has no metadata, so a
joiner of a freshly created one stayed read-only, and
`peerbit-fs mount <address>` failed after 120 s with "did not establish a
safe initial write view".

Two behaviour changes make this a minor release. A program loaded from an
address through the Program API is now write-gated like any address open,
and a creating open ignores `bootstrap` options, including
`mode: "require"`.

- Creating a filesystem now publishes a signed zero-document genesis
  manifest when the creator is a trusted full replica and automatic
  snapshots are enabled, before the creating open returns. A creating open
  no longer runs a cold-start bootstrap: a new filesystem has nothing to
  bootstrap from. `peerbit-fs create` no longer publishes its own; the
  library does it for every creator, and `create` now fails if the genesis
  is missing instead of printing an address nobody can join.
  `snapshot: { disabled: true }` skips it.
- Only a program constructed locally creates. A program loaded from an
  address, whichever API opens it (`SharedFileSystem.open(address, ...)`,
  `peer.open(address)`), is now an address open like `openSharedFs` with an
  address: it stays gated until it settles a remote view, and it never
  publishes a genesis. Before, it was write-ready at once as a "creator".
- Until something is written, the author of a genesis puts that manifest
  again (a linked put) whenever a peer session subscribes to the filesystem,
  and when it reopens while peers are subscribed. A joiner whose first join
  ended before it was ready (Ctrl-C, a crash, a mount timeout) already holds
  the genesis, so without a new entry every retry stayed gated until someone
  wrote. A session subscribes even when it returns after a crash, for which
  shared-log may emit no `replicator:join`. Retrying needs the creator
  online. Each peer session adds one small entry while the filesystem stays
  never-written. Only the author of a zero-document manifest listens for
  sessions, and it stops once something is written; closing the filesystem
  also removes the listener.
- The first real snapshot CUTs that chain. A zero-document manifest counts
  as no snapshot, so the publisher replaces it at its first check after
  something is written, as it would publish a missing manifest, instead of
  waiting for 50 changes or an hour. A peer that was offline across that
  snapshot can still bring older chain entries back as orphan log heads.
  They cost a little log space and change nothing else; removing them needs
  upstream log support. The entries are not CUT sooner: a peer that returns
  holding an entry an earlier CUT removed would put it back for good.
- A replicated snapshot manifest now counts as readiness evidence, like
  replicated metadata. A gated joiner cannot publish one, so it came from
  another peer.
- A zero-document manifest is no longer a bootstrap candidate. It installs
  nothing, and its overlay retired at once, counting as verified coverage
  and readiness evidence without covering any log entry, though a genesis
  can be older than the data. Such joiners now plain-join, where the
  manifest's replication is the evidence. A join with
  `bootstrap: { mode: "require" }` of a never-written filesystem fails and
  says that only zero-document manifests were found. Snapshots with
  documents are unchanged. This also stops a reopen of an empty filesystem
  from briefly rejecting `prepareForDisposal` while it "bootstrapped" from
  its own genesis.
- `snapshotWrite` replaces the previous manifest with one put that CUTs its
  head, instead of a delete followed by a put. A joiner that never held the
  old manifest could keep the delete entry pending in its sync and never
  become write-ready. In a local repro this hit about half of the joins to
  any filesystem whose author had published twice.

The rest of the gate is unchanged: a settled bootstrap, a connected
replicator, an idle synchronizer and the quiet window. A joiner that reaches
no replicator stays closed. There is no format change: the genesis is an
ordinary bootstrap manifest and each re-publication an ordinary put.

Known gap: the genesis proves only that sync with some replica started, and
a replica vouches from its own view. One that missed writes while it was
offline, such as a creator restarting after another machine wrote and left,
still vouches that the filesystem is empty, so a joiner that reaches only
that replica becomes write-ready on an empty view. Nothing is lost: the
missed writes merge when a peer holding them comes back, and clashing paths
become conflict copies. This is the same exposure as settling on any donor's
partial view. Closing it needs a per-peer sync frontier from Peerbit
upstream.
