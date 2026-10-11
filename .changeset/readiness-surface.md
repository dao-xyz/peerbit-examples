---
"@peerbit/shared-fs": minor
---

Write readiness reports its progress and every source.

- A `readiness:progress` event on `fs.program.events` carries the
  `bootstrapStatus().readiness` snapshot whenever a joining replica's peers
  change state, and `awaitWriteReady({ onProgress })` calls back with it while
  it waits. Neither fires once the replica is writable.
- `write:ready` is dispatched for every source, once per open, including a
  creating open and a warm reopen (as the open's last step).
- Open option `writeReadiness: { requestTimeoutMs }` (default 5000, from 100
  to 25000): how long a join waits for a peer's first answer; the next two
  attempts wait twice and four times as long. A shorter value never releases
  an unanswered peer sooner (a replicator with no sign of life is still asked
  for at least 5000 ms).
- Telemetry adds `readiness-peer`, `writers-unheard` (access-controlled
  stores) and `write-ready-timeout`; `write-ready` adds `warm`, `contained`,
  `excluded` and `gaps`. A `BootstrapTelemetryEvent` consumer that switches
  exhaustively on `type` must add the new cases.
- `describeReadiness()` is exported, with the `ReadinessPeerState` and
  `ReadinessPeerReason` types.
- `bootstrapStatus().msSinceLastArrival` is removed; wait with
  `awaitWriteReady()` instead of for a quiet store.
- `awaitWriteReady({ timeout })` refuses a timeout above 2147483647 ms with
  `EINVAL`, as it does other invalid values; Node would run such a timer after
  1 ms.
