---
"@peerbit/shared-fs": patch
---

Fix a join that could stay write-gated on a quiet filesystem. This affected a
join that did not install a snapshot, such as a `bootstrap: false` open or one
whose peers had no usable snapshot. When the last batch of file metadata from
the other peers landed exactly as the local store finished opening, the joiner
lost track of it and waited for a new change before it allowed writes. If
nobody wrote again, it waited indefinitely.

Reopening the same filesystem object after closing it no longer leaves the
previous session's change handler running beside the new one.

These were found in code review, not reported by a user.
