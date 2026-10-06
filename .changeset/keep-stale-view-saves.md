---
"@peerbit/shared-fs": patch
---

Two kinds of save made on a machine that had not yet received another
machine's newer change are no longer lost, and a native-mount save that
writes back another machine's bytes unchanged no longer hides that change.

- Saving a file with the bytes it already showed was skipped, so if another
  machine had changed the file meanwhile, that change won and no conflict was
  listed. Now, when the shown bytes came from another machine, the save is
  recorded as one version that reuses the stored bytes (no new chunks) and
  ranks exactly where the shown version ranked. A change made elsewhere on top
  of that version then shows up as a conflict and stays the visible version,
  and a delete made elsewhere stays visible with the save restorable. Garbage
  collection keeps such a version while it is among the newest
  `keepVersions` without counting it, so it never pushes an older version
  out. Through `writeFile` and `writeBatch`, saving bytes this machine
  already wrote still costs nothing, and each machine records at most one
  such version of the same bytes, so machines taking turns re-saving a file
  add one version each, not one per save.
- A `chmod` on one machine and a `touch` on another kept only one of the two
  changes. Both now survive: `stat()`, `list()`, the next write,
  `resolveConflict()` and a naming restore take the mode and the
  modification time each side changed, and the later of two changed
  modification times. Garbage collection keeps the version this merge needs,
  except on a machine that collects before the other side's change reaches it
  (see the README's Conflicts section).
- A write through a native mount advances the modification time, so every
  mount save still publishes one version, as before. When it saves the bytes
  and mode the open file showed, that version is now recorded the same way
  as above, carrying the new modification time, whichever machine wrote
  those bytes, so a change made elsewhere on top of them stays visible
  instead of tying with it. This holds for every such save, not only the
  first, and also when that change arrived while the file was open. These
  versions count toward `keepVersions` like the ones such saves published
  before, and each lists at most one version besides the ones it was saved
  over. Only a save that also sets another modification time (`cp -p`,
  `touch -r`) over bytes this machine wrote counts as a `touch`, which ties
  with a change made elsewhere. A shell redirect (`cmd > file`) on Linux no
  longer publishes an empty version before the bytes, so it counts as one
  such save. A change that only empties a file (`: > file`) now publishes
  when the descriptor that emptied it is released, which Linux does just
  after `close(2)` returns; a background job started with `> file` keeps the
  previous bytes visible until it closes the file, or writes and flushes. A
  save that writes a new file and renames it over
  the original replaces the file, so a change made elsewhere to the original
  is listed as a delete-vs-edit naming conflict, as before.

Applications that open one Peerbit identity on several devices must pass each
device its own `machineLabel`: the default label is "unknown-machine", and
two devices with the same label count as one machine, so each one's save of
the other's bytes is still skipped.
