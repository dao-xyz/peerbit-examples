---
"@peerbit/shared-fs-cli": minor
---

`mount --peer` now starts when that peer is down and reconnects to it. Before,
a `--peer` that could not be dialled stopped `mount`, and no mount registered
its `--peer` addresses for a redial. Now `mount` warns, naming the address,
mounts from local state, and Peerbit's bootstrap recovery redials the `--peer`
addresses with backoff (about 1 s, doubling to 60 s) whenever the mount has no
connections: at startup, and after it loses its last connection, such as when
a hub restarts at the same address. A remount from a writable state directory
is writable meanwhile; a first mount still needs a peer that holds the
filesystem.

The new repeatable `--bootstrap <multiaddr>` replaces the public bootstrap
list, which is then not fetched, wherever `--peer` is accepted; `mount` redials
these addresses too. Given together, both are used. Without either option
nothing changes. The other commands still fail at once, now naming the
address, when a `--peer` cannot be dialled or no `--bootstrap` node answers.

For code that imports the CLI module: `connectMountToNetwork(peerbit, network,
warn?)` now takes the parsed options `{ peer, bootstrap }` instead of the
`--peer` value, and `connectToNetwork` is exported. No wire or storage format
changes.
