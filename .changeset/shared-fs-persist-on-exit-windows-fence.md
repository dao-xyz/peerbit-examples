---
---

The mount --persist-on-exit tests that expect the fence to succeed give it
120 s on Windows for now, where the replica that rejoins inside it can take
longer than 30 s to confirm what it missed. The CLI README says to raise
`--persist-timeout-ms` for such a replica. No version bump.
