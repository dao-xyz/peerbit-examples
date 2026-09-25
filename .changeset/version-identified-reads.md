---
"@peerbit/shared-fs": patch
---

Add `readFileWithVersion(path, { mode })`, which returns verified bytes with the
id of the version actually read, the visible head, all current heads and
whether an ancestor was substituted for an unavailable head. The `"exact"` mode
never substitutes and throws `SharedFsVersionUnavailableError` (code `EIO`),
matching exact-version mount reads. `readFile()` returns the same bytes as
before. The artifact-ignore `rulesFileAuthors` gate now checks the advisory
author of the rules-file version it installs, so an unavailable allowed head can
no longer cause rules from an unchecked ancestor to be installed.
