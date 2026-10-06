---
"@peerbit/shared-fs": patch
---

Scheduled garbage collection now waits for proven write readiness, as manual
`collectGarbage()` already did. A joining peer that was still write-gated when
its first scheduled run came due (5 to 95 minutes after open) could plan GC
against an incomplete view; that run now skips and the schedule tries again a
full interval later. An `allowPartialWrites` session skips scheduled runs too,
also on a reopen that had a warm readiness proof.

`allowPartialWrites` no longer arms the resurrection guard on a view that was
never proven complete. Before, a bootstrap that fell back to a plain join, a
verified snapshot retirement, or a quiet unverified store armed it in such a
session. A warm reopen with the override keeps the guard armed, since its view
was proven before.

These were found in design review, not reported by a user.
