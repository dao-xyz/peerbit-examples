---
"@peerbit/shared-fs": patch
---

A fresh join no longer stays write-gated for ten minutes or more when the
donor's files reach it while its store is still opening. That happens when the
open is slow, for example on a heavily loaded machine, so the donor's history
arrives before the joiner's own store has finished opening. The join then
treated the files it had just received as a partial bootstrap left by an
interrupted earlier session. When the donor had no snapshot to install, the
join held the unverified posture, which lifts only after two quiet checks five
minutes apart. The same mix-up held a `bootstrap: false` retry of a stopped
join in that posture too.

The join now checks what the store held before it stores anything it receives,
so only files an earlier session stored count as a partial bootstrap. A fresh
join without a snapshot now joins plainly and becomes write-ready after the
usual remote evidence and quiet window. A store with files from an interrupted
earlier session still reopens in the unverified posture, and a marker left by a
bootstrap that retired unverified keeps that posture.

No user reported this. A test that slowed the store open by 3 seconds found it:
the join was not write-ready within 45 seconds in both runs, and was ready in
about 6 seconds without the delay. New tests hold the open until the donor's
files have arrived, and they fail without the fix.
