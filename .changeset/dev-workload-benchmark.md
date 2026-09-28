---
---

Add an opt-in, report-only developer-machine workload to the mounted-path
benchmark: a git clone and `git status` runs over a pinned synthetic
2,000-file source tree, editor-style atomic saves, fsync'd JSONL appends at
4 MiB and 32 MiB, and SQLite insert transactions, each on the mount and the
same-runner local control. Tooling only; no package change.
