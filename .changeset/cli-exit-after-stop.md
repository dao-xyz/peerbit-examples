---
"@peerbit/shared-fs-cli": patch
---

One-shot commands such as `whoami`, `create`, `trust` and `conflicts` now
exit once their work and their peer's stop are done, whatever a dependency
leaves armed. Before, such a command could print its result and then not
exit: a libp2p circuit-relay reservation answered while the peer stopped
could leave its refresh timer armed for almost two hours. Now a process
that something still keeps alive 2 seconds after the stop exits then, once
stdout and stderr have written everything, with the exit code the command
set. A process that nothing keeps alive exits as soon as before. `mount` is
unchanged: it already exits once its stop and persist-on-exit are done.
