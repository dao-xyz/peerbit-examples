---
"@peerbit/shared-fs": patch
---

`close()` no longer waits on the `writers-unheard` telemetry. With
`telemetry.bootstrap` set, an access-controlled replica reports
`writers-unheard` once after its join turns writable, and `close()` waits for
that report to end. The report read the trusted writer keys through the trust
graph's peers (`TrustedNetwork.getTrusted()`), which waits out a search timeout
for each peer that does not answer: once the peers it had asked stopped,
closing the replica took about two minutes. The report now reads the trusted
keys from this replica's own trust graph and stops when the filesystem closes,
so `close()` no longer waits on other peers for it. The event's fields are
unchanged. `trustedWriters()` still asks the trust graph's peers.
