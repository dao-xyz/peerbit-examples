---
---

Add an opt-in, report-only developer-machine workload to the mounted-path
benchmark: an editor-style atomic save, fsync'd JSONL appends at 4 MiB and
32 MiB, SQLite insert transactions, and a git clone and `git status` of a
pinned synthetic 2,000-file tree, each on the mount and the same-runner local
control. Tooling only; no package change.
