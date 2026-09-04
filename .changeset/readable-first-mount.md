---
"@peerbit/shared-fs-cli": patch
---

Add an opt-in `mount --readable-first` mode that exposes the current cold-join
read view while the existing backend write gate continues returning retryable
`EAGAIN`. Native FUSE and macFUSE callers receive `EAGAIN`; current WinFsp
callers receive retryable `EBUSY` because WinFsp does not preserve FUSE errno 11.

Warn when a fallback view can be partial, report the later writable transition,
and safely detach and join background readiness work on timeout or shutdown.
The CLI patch publishes matching rebuilt native adapter binaries.
