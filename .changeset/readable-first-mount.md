---
"@peerbit/shared-fs-cli": patch
---

Add an opt-in `mount --readable-first` mode that exposes the current cold-join
read view while the existing backend write gate continues returning retryable
`EAGAIN`. Native FUSE and macFUSE callers receive `EAGAIN`; current WinFsp
callers receive retryable `EBUSY` because WinFsp does not preserve FUSE errno 11.

Warn when a fallback view can be partial, report the later writable transition,
and safely detach and join background readiness work on timeout or shutdown.
Under the required exclusive ownership of the mountpoint, the CLI wrapper now
proves its reserved virtual root sentinel is absent before spawn and accessible
after the adapter's legacy initialization signal. This is an operational
attachment proof, not an adversarial TOCTOU proof; cgofuse does not guarantee
`Init` runs after namespace attachment.
Readable-first adapter startup now receives the lifecycle's remaining deadline
and abort signal. The abortable external adapter is required because the
in-process fuse-native startup cannot guarantee that an abandoned mount will
not attach later.
The CLI patch publishes matching rebuilt native adapter binaries.
