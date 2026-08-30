---
"@peerbit/shared-fs": minor
"@peerbit/shared-fs-cli": minor
---

Write-set barriers: `writeBatch(entries, { manifest: true })` publishes an inner-signed changeset manifest recording the batch's exact membership, committed after every member so a crashed prefix never certifies. Any replica gates on the turn with `awaitChangeset` — resolving when every member document has been admitted locally. Store salt v8 -> v9 (new document kind): recreate filesystems and upgrade all peers together.

- Honest verdicts: historic turns whose members were garbage-collected resolve "collected-or-incomplete"; unknown ids time out (default 30s) with the full status attached to the error.
- `changesetStatus()` snapshots the same view; `watchChangesets()` streams manifest arrivals and once-per-transition completions, queued during a bootstrap overlay so a triggered read always sees the whole turn.
- Manifest-scoped barriers are unforgeable: member ids are unguessable 32-byte identities bound under the manifest's inner signature, so no other writer can satisfy or extend the barrier.
- Same-changesetId retries after a crash are safe: no-op entries adopt the young documents that already satisfy them (48h adoption horizon, the GC grace floor), and applied edits and deletes adopt their young naming context.
- Hostile manifests are bounded at ingest (payload/member caps, store binding, authenticated author mirrors, 1h future-clock skew); manifests retire by local arrival age in `collectGarbage` (`GcReport.manifestsRetired`).
