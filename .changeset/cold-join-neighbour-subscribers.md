---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Keep a peer that joins next to a replicator from missing it. A joiner used to
learn which peers hold a filesystem from one Subscribe announcement, sent
through the topic's shard overlay. When that announcement was lost, the joiner
could be connected directly to a replicator and still see no subscriber, so
`list` failed with "Path does not exist" until something else repaired
discovery. CI hit this once: a cold join of a 500-file tree waited out its
90 s budget, and the automatic retry passed in seconds.

Opening a filesystem now asks each directly connected pubsub neighbour for
the log topic's subscribers, and asks each new neighbour once its outbound
stream is ready. The request is Peerbit's `requestSubscribers(topic, peer)`,
sent over the neighbour's own stream, so it does not depend on the shard
overlay. The neighbour answers directly, and shared-log's capability exchange
then makes it ask back, so both sides learn each other.

A local harness drops the joiner's overlay announcement on purpose. With it,
17 of 50 joins without this change still saw no subscriber after 30 s.
With this change, 0 of 50 stalled, and the joiner could read the tree 0.35 s
(median) and at most 2.3 s after open started.

This covers a subscriber that is a direct neighbour: the test topology and
the usual `peerbit-fs mount <address> --peer <multiaddr>` join. A joiner that
reaches the replicators only through a relay that does not subscribe is not
helped, and the separate ~90 s open stall seen with several concurrent fresh
joiners still needs an upstream fix.
