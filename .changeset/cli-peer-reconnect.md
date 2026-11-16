---
"@peerbit/shared-fs-cli": minor
---

`mount --peer` now starts when that peer is down and reconnects to it. Before,
a `--peer` that could not be dialled stopped `mount`, and only a `--peer` that
answered at mount start was ever dialled again. Now `mount` warns, naming the
address, and goes on, and every `--peer` is registered for Peerbit's pubsub
redial whatever its first dial did. Pubsub redials a down address about once a
second while the mount runs, also while the mount is connected to other
peers, so a hub restarted at the same address is usually connected again
within about 2 s. A remount from a writable state directory is writable
meanwhile; a first mount still needs a peer that holds the filesystem, and
when none answers its error now names the addresses it could not reach.
Without `--bootstrap`, a `--peer` mount still never bootstraps, so its pubsub
topic-root candidates stay automatic, and no `--peer` mount uses Peerbit's
bootstrap recovery, whose bootstrap would pin them to the nodes it reached.

The new repeatable `--bootstrap <multiaddr>` replaces the public bootstrap
list, which is then not fetched, wherever `--peer` is accepted. A mount
bootstraps from it and, without `--peer`, recovers from it whenever it has no
connections at all, with backoff from about 1 s to 60 s. Given together, the
mount bootstraps from the `--bootstrap` list and dials each `--peer`. Without
either option only messages change: a mount that cannot reach the public
network no longer says it mounts from local state, and names that network if
its open then fails. The other commands still fail at once, now naming the
address, when a `--peer` cannot be dialled or no `--bootstrap` node answers.

For code that imports the CLI module: `connectMountToNetwork(peerbit, network,
warn?)` now takes the parsed options `{ peer, bootstrap }` instead of the
`--peer` value, uses `peerbit.services.fanout`, and returns what it could not
reach; `connectToNetwork` and `mountOpenError` are exported. No wire or
storage format changes.
