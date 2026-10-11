---
"@peerbit/shared-fs": patch
---

A write-ready replica now stays write-ready when a reopen ends while its
snapshot bootstrap is still running. A reopen of a write-ready replica whose
store holds no content (for example the creator's own directory before anything
was written) starts a snapshot bootstrap, and that bootstrap wrote an
interrupted-bootstrap marker to the local state file. When the process stopped
before the bootstrap decided, the next open read the marker, dropped the
replica's write readiness and waited for a proof from another replica. So
`peerbit-fs create` followed by `peerbit-fs status <address>` twice left the
creator's own directory gated. Such a bootstrap no longer writes the marker. An
open without write readiness still writes it.
