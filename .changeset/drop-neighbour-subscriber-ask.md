---
"@peerbit/shared-fs": patch
"@peerbit/shared-fs-cli": patch
---

Stop asking each directly connected peer for the filesystem's subscribers on
open. shared-fs added this in 0.15.0 after a cold join in CI waited 90 s with
"Path does not exist", because the joiner never learned that the replicator
next to it held the filesystem. Since the Peerbit 5.4.9 cohort, pubsub covers
the same neighbours with its own direct exchange: it sends each direct
neighbour its subscriptions, with a request to answer, when it subscribes and
when a neighbour's stream opens. In normal operation the shared-fs request is
therefore redundant.

A cold-join soak of the multi-party workload with the shared-fs request
turned off stalled 0 of 1,500 times on Peerbit 5.4.10, against 3 of 542 on
5.4.6 (Fisher p=0.019; 95% upper bound 0.2%). Cold-join time did not change
(median 1.41 s without it, 1.47 s with it).

One induced case is not covered. When a test drops every subscription
announcement the joiner sends for the log topic, including the direct one to
its neighbour, and the joiner happens to be that topic's shard root, the join
stalls without the shared-fs request (10 of 10 runs on 5.4.10) and recovers
with it (0 of 10). The joiner then finds no snapshot and stays write-gated
rather than becoming writable. This needs the direct neighbour message itself
to be lost, which never happened in the soak, and the fix belongs in Peerbit:
the shard root should announce again once it subscribes. A new test checks
that pubsub keeps sending the direct exchange.
