---
"@peerbit/shared-fs": patch
---

Garbage collection after reopening a large filesystem is faster, and the
filesystem's own index reads in snapshots and garbage collection no longer
grow with the square of the file count. Both list every file by scanning the
local index. Those scans read the index in pages of 100 rows, and each page
skipped over every row before it. Scans that only need index rows now take a
single read. Garbage collection's scans of arrival times read only each
row's id and arrival metadata, 8,192 rows at a time, so a store with many
chunks does not need more memory for them than before. Scans that load
documents read 20,000 at a time. Path lookups that are served from index
rows no longer load a log entry for each row.

The check on reopen for whether the store already holds files now looks up
each content kind separately. Before, it sorted every content row first.

Index reads that run while the filesystem is closing, such as path lookups
and directory listings, now fail with a closed error. Before, they could
report a file or directory as missing.

Results are unchanged. The first snapshot after a reopen takes about as long
as before: it runs while Peerbit's shared log rebalances the reopened store,
and that rebalance dominates its time. Most of the time spent opening a large
filesystem is in Peerbit's own index scans at open, and this change does not
affect those either.
