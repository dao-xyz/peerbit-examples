---
"@peerbit/shared-fs-cli": patch
---

`peerbit-fs mount` no longer fails when the Peerbit bootstrap nodes cannot be
reached. It warns, mounts from local state and turns on Peerbit's bootstrap
recovery, which redials with backoff whenever the mount has no connections, at
startup and after later network loss. Joining a remote filesystem still waits
for the write-readiness fence, so an offline join fails safely. `--peer` keeps
the mount off the public network as before.
