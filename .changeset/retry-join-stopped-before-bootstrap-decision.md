---
"@peerbit/shared-fs": patch
---

A `bootstrap: false` open no longer stays write-gated for ten minutes or more
after an earlier join of the same directory stopped (Ctrl-C, a mount timeout, a
crash) while its cold-start bootstrap was still looking for a snapshot. That
join leaves its bootstrap marker on disk, and a bootstrap-off open took any
marker for a possibly partial store: it held the unverified posture, which lifts
only after two quiet checks five minutes apart, whatever the retry received.
Such an open now checks the store first, as a bootstrap-enabled open already
did. When the store holds no file content (no names, versions or chunks), the
stopped join installed nothing, so the open clears the marker and joins like a
fresh bootstrap-off join, gated by the usual remote evidence and quiet window.
A store with content, or a marker left by a bootstrap that retired unverified,
keeps the unverified posture. Partial replicas (such as `replicate: false`)
make the same check, so in that case they report phase `off` instead of
`unverified`.

This was the load-sensitive failure of the cold-start bootstrap test "lets a
join of a never-written filesystem that ended before it was ready be retried":
its second joiner was sometimes stopped before its bootstrap decided, and the
bootstrap-off retry timed out awaiting write readiness. A new test stops a join
at that point every time.
