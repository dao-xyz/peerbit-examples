---
"@peerbit/shared-fs": patch
---

Resolve paths in directories that have not been listed with an exact `(parent, name)` index query instead of reading the whole directory. A cold `stat` or lookup in a wide directory now costs one small query instead of a full directory scan. The results are kept in a separate bounded cache: at most 4,096 slots, 16,384 rows and about 8 MiB (estimated). A name history too large for that cache is still returned in full, just not cached, and it never evicts other entries. Once a directory has been listed, its lookups are still answered from the listing with no queries, and the directory-listing cache works exactly as before. Results are unchanged. After 32 exact queries under one unlisted directory, as in a bulk create or scan, the next lookup reads and caches the whole directory once, as every lookup did before, so later lookups there need no query. Waiting lookups at the 64-query cap are admitted in FIFO order, and identical lookups share one query.
