---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Remove pre-release compatibility machinery. This is a breaking change made
before 1.0; shared-fs has no production users, so no migration path is kept.

Library API removals:

- `SharedFileSystem.trustLegacyLocalReplica()` and
  `SharedFsHandle.trustLegacyLocalReplica()`, and the exported
  `TrustLegacyLocalReplicaOptions` type.
- `BootstrapStatus.legacyPromotionEligible`.
- The `"legacy-operator-assertion"` value of
  `BootstrapStatus.writeReadinessSource` and of the cold-join telemetry
  `write-ready` event `source`. Both are now `"creator" | "remote-settled"`.
- `SharedFsVersionInfo.deleted` (deprecated and always `false`). It also
  disappears from `writeFile()`, `writeBatch().results`, `versions()`,
  `conflicts()` and `versionsByChangeset()` results. Deletion is reported by
  naming events.
- The exported `FileHead` type and `isFileHead()` guard. Use `FileVersion` and
  `instanceof FileVersion`.

CLI removals:

- The `peerbit-fs trust-legacy-replica` command.
- `filesystem.bootstrap.legacyPromotionEligible` in `status --json`, and the
  `legacy promotion eligible:` line in text `status`.
- The `deleted` key in version objects printed by `conflicts --json`,
  `status --include-conflicts --json` and `resolve-conflict --json`.
- The mount write-readiness timeout message no longer suggests
  `trust-legacy-replica`.

Local readiness sidecar (`<directory>/shared-fs-bootstrap/<address>.json`):

- New writes contain only `writeReady`, `writeReadySource` and `bootstrap`.
  The `openedBefore` and `legacyUnproven` keys are no longer written.
- The reader ignores those keys, so an existing sidecar that still contains
  `openedBefore` or `legacyUnproven: false` stays valid, and its readiness
  proof is kept.
- A sidecar whose `writeReadySource` is `"legacy-operator-assertion"` is now
  malformed. The store fails closed: it reopens gated (not write-ready, guard
  disarmed) until remote-settled readiness, with no data loss. Missing,
  unreadable and malformed sidecars are still fail-closed.
- Downgrading to an older release after this change makes warm reopens gated,
  because older readers require `openedBefore`. That costs availability, not
  safety.

Write-readiness donor check: a transport without the DirectStream route API
(`routes.isReachable` and `routes.getBestRouteHint`) and the live `peers` map
can no longer prove a donor, so readiness fails closed. The pinned Peerbit
transports provide both, so current behavior is unchanged.

There is no wire-format change.
