---
---

Test-only: the shared-fs cold-start hold releases once the joiner's store
holds the history it waits for (in the log and the index), however that
history arrived, instead of waiting for a commit diagnostic that entries
joined one at a time never emit. No package change.
