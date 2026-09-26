---
"@peerbit/shared-fs": patch
---

Resolve paths in directories that have not been listed with an exact `(parent, name)` index query instead of reading the whole directory. A cold `stat` or lookup in a wide directory now costs one small query instead of a full directory scan. The results are kept in a separate bounded cache: at most 4,096 slots, 16,384 rows and about 8 MiB (estimated). A name history too large for that cache is still returned in full, just not cached, and it never evicts other entries. Once a directory has been listed, its lookups are still answered from the listing with no queries, and the directory-listing cache works exactly as before. Results are unchanged. The trade-off: creating or checking many different names in a directory that has not been listed now costs one small query per name instead of one directory scan.
