---
"@peerbit/shared-fs": patch
---

Make small edits to large files cheap by batching the per-chunk dedup
bookkeeping of `writeFile` (and `writeBatch`). The W1 presence probe now
covers up to 128 chunks per index query, and the W2 re-verification after the
version lands is one batched probe instead of one per chunk. A fresh parent
version the write loaded (the mount's explicit base, or the current head)
witnesses the chunks it references without a witness query: it is re-read
from the local index in the same presence probe and counts only when that row
is a file version younger than the skip horizon. The remaining present chunks
share batched fresh-witness queries. These reads come straight from the local
index rows, without loading each row's log head. A 4 KiB overwrite into a
32 MiB file (64 chunks) now issues one presence probe, no witness query and
one W2 probe, instead of 64 probes, 63 witness queries and 64 W2 probes.

Every skip/put decision is unchanged: a chunk is skipped only when it is
present and a file version created within the skip horizon references it;
dedup defaults, the horizon, GC rules, formats and public APIs are unchanged,
and `dedup: "off"` behaves as before. The `writeFile.touchChunks` profile
detail adds `probeQueries` and `baseWitnessed`; `probes` still counts chunks,
`witnessQueries` now counts batched witness rounds, and `probeNs`/`witnessNs`
are the wall time of those queries.
