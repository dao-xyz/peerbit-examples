---
"@peerbit/shared-fs-cli": minor
---

Commands now reach a running mount. `peerbit-fs mount` serves a control
endpoint for its state directory, and `status` (also `--json` and
`--include-conflicts`), `conflicts` (also `--fail-if-any`, with exit statuses
3 and 4), `naming-conflicts`, `resolve-conflict`, `resolve-naming-conflict`,
`trust`, `revoke` and `gc`, run for that `--directory`, go through it: the
mount runs them on its live filesystem, and they print what they print and
exit as they do on the stopped directory. Before, every command failed on the
lock Peerbit holds on a mounted state directory. The other commands that open
the directory (`create`, `whoami`, `mount`, `benchmark`, `snapshot`,
`prepare-disposal`), and a served one whose request the mount cannot take,
now print `a mount is running for this directory (pid N); ...` and why, and
exit 1. With no mount running, nothing changes.

Only the mount's user can use the endpoint: on Linux and macOS a socket of
mode 0600 in a new directory of mode 0700 (`<directory>/mount-control/`, or
`/tmp/pbfs-ctl-*` when that path does not fit a socket address), on Windows a
named pipe whose access list admits only the current user. Every request also
carries a random token from `<directory>/mount-control.json` (mode 0600),
compared in constant time; that file names its state directory by device and
inode, so a copy of it elsewhere names no mount. `mount` removes both when it
exits, also after its adapter died, a failed start, or a shutdown signal
while it starts (exit 130); the next `mount` replaces what a killed one left.
A request is one line of JSON of at most 1 MiB, due within 30 s of
connecting, with a protocol version, and the mount refuses another
peerbit-fs version. A stopping mount refuses new requests and waits up to
10 s for a change a command has begun, also once Ctrl-C ended the command,
so that the change is done before Peerbit stops and persist-on-exit waits
for the filesystem entries it wrote. No storage format changes.
