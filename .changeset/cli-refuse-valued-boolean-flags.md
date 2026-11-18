---
"@peerbit/shared-fs-cli": patch
---

A boolean flag given a value other than `true` or `false` is now refused
instead of being read as false. Before,
`peerbit-fs conflicts <address> --fail-if-any=1` silently turned the CI gate
off and exited 0 over a conflict, and `create --auth=1`, `gc --dry-run=1` or
`mount --require-fresh=1` ran as if the flag were off. Every boolean option
of every command, in each spelling (`--fail-if-any=1`, `--failIfAny=1`),
now gives a usage error before the command runs: the command's usage, then
one line naming the flag, such as
`--fail-if-any=1: --fail-if-any takes no value`, and exit 1.
`--no-<flag>=<value>`, already refused as an unknown argument, gets the same
line. So do a dotted name in any form, such as
`mount --assume-complete.x=0` or `--no-assume-complete.x`, and a spelling
yargs only camel-cases onto the option given a value, such as
`--assume-Complete false`, each of which turned the override on.
`--persist-on-exit=<value>` keeps its hint to set the wait with
`--persist-timeout-ms`. `--fail-if-any`, `--no-fail-if-any`,
`--fail-if-any=true` and `--fail-if-any=false` work as before, other options
keep their values, and arguments after `--` are not read.
