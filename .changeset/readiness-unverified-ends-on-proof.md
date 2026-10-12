---
"@peerbit/shared-fs": patch
---

A joining replica in the unverified bootstrap posture now becomes writable as
soon as its readiness join proves its view, instead of after about 10 minutes
without new rows. The posture follows a snapshot overlay that retired before
its rows were covered, or a bootstrap resumed over a partial store. Neither
serves overlay rows, and the proof covers the store, so the proof now decides
there too. Its state-file write also clears the posture's marker, and the
replica continues in phase `off` like a plain join that reconciled: the
resurrection guard arms, `bootstrap:converged` fires with `verified: false`,
and the replica may publish snapshots and pass the disposal checks, which a
replica that only waited the posture out could not; a proof that lands after
the quiet period ended the posture moves the replica to `off` too. A crash
before that write leaves the marker, so the next open is gated again.
`assumeComplete()` is now also accepted in the unverified posture and, on a
replica that is not yet writable, ends it the same way; it still fails with
`EAGAIN` while a snapshot overlay is fetching or active. An open that runs no
join (a warm reopen, `allowPartialWrites`, or a partial replica) still leaves
the posture only after the quiet period.
