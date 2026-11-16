---
"@peerbit/shared-fs-cli": minor
---

`mount` saves files still open at shutdown and, once another replica of the
filesystem was seen in the session, waits until one acknowledges every entry
the mount wrote in that session (`--persist-on-exit`, on by default;
`--persist-timeout-ms`, default 30000; `--no-persist-on-exit` opts out). It
exits 75 and lists the unacknowledged paths on stderr when the wait gives up,
and 130 when a second shutdown request aborts it. A `shutdown` line on a piped
stdin and Ctrl-Break stop a mount on Windows, which has no SIGTERM.
