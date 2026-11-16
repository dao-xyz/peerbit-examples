---
"@peerbit/shared-fs-cli": minor
---

`mount` saves files still open at shutdown and, once another replica of the
filesystem was seen in the session, waits until one acknowledges every entry
the mount wrote in that session (`--persist-on-exit`, on by default;
`--persist-timeout-ms`, default 30000; `--no-persist-on-exit` opts out;
`--persist-on-exit=<value>` is refused). It exits 75 and lists the
unacknowledged paths on stderr (200, then a count) when the wait gives up. A
request once the wait runs aborts it and exits at once (130); the copy of a
Ctrl-C that npm, pnpm and npx pass on is ignored. SIGHUP stops a mount too, a
`shutdown` line on a piped stdin and Ctrl-Break stop it on Windows, which has
no SIGTERM, and a failed unmount no longer skips the save and the wait. Exit
1 (a failure, or an open file that could not be saved, now reported as
`persist-on-exit: unsaved`) is kept over 75 and 130.
