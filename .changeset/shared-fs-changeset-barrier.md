---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Write-set barriers: `writeBatch(entries, { manifest: true })` publishes an
inner-signed changeset manifest recording the batch's exact membership
(committed after every member, so a crashed prefix never certifies), and
any replica can gate on the turn with `awaitChangeset(changesetId,
{ manifestId })` — resolving when every member document has been admitted
locally, with honest verdicts for historic turns whose members were
garbage-collected ("collected-or-incomplete") and unknown ids (timeout
with full status attached). `changesetStatus()` snapshots the same view;
`watchChangesets()` streams manifest arrivals and once-per-transition
completions, queued during a bootstrap overlay so a triggered read always
sees the whole turn.

Manifest-scoped barriers are unforgeable: member ids are unguessable
32-byte identities bound under the manifest's inner signature, so no
other writer can satisfy or extend the barrier — and same-changesetId
retries after a crash are safe, because no-op entries adopt the young
documents that already satisfy them (48h adoption horizon = the GC grace
floor). Hostile manifests are bounded at ingest (payload/member caps,
store binding, authenticated author mirrors, 1h future-clock skew).
Manifests are retired by collectGarbage once their local arrival age
exceeds the retention window (GcReport.manifestsRetired).

Store salt v8 -> v9 (new document kind): recreate filesystems and upgrade
all peers together, per the standing no-production-users policy.
