# Merkle algorithm benchmark

This manual, report-only harness measures the experimental Merkle patch builder
and range reader from PR #329. It does not publish Documents, mount a filesystem,
replicate data, wait for persisted receipts, or call `fsync`. Its results cannot
select the production leaf size or establish a performance gain over flat v9.

Build once, then run from the repository root:

```sh
pnpm --filter @peerbit/shared-fs run build
node --test scripts/shared-fs-merkle-benchmark.test.mjs
node --expose-gc scripts/shared-fs-merkle-benchmark.mjs > merkle-map.ndjson
```

Defaults are 4/64 MiB files, 64/256/512 KiB leaves, one warmup and three measured
samples per case. The seven cases cover seeded random 4 KiB overwrite, a 4 KiB
overwrite crossing every leaf layout's boundary at the same file offset,
4 KiB append, truncate, zero regrowth after truncate, sequential write in 1 MiB
builds, and sequential read in 1 MiB ranges. Each write sample starts from the
same base file, except that regrowth starts from an untimed truncated root.

Both stores retain canonical Borsh bytes and decode them on load. `--store map`
keeps those bytes in memory; `--store disk` uses one ordinary buffered local file
per block, with no persistence barrier. Samples use a disposable output store
that can read the unchanged fixture store. Intermediate sequential-write trees
are retained until that sample ends. Map and disk results are separate storage
conditions and must be labeled as such.

```sh
# A short overwrite-only matrix.
node --expose-gc scripts/shared-fs-merkle-benchmark.mjs \
  --cases random-overwrite-4096,boundary-overwrite-4096 \
  --samples 5 --warmups 1 > merkle-overwrite.ndjson

# Explicitly opt into a large disk-backed fixture.
node --expose-gc scripts/shared-fs-merkle-benchmark.mjs \
  --store disk --sizes-mib 1024 --leaves-kib 64,256,512 \
  --cases random-overwrite-4096,append-4096,truncate,regrow-zero \
  --samples 1 --warmups 0 > merkle-1gib-disk.ndjson
```

All list options reject duplicates. File sizes must be integer MiB from 1 to
1024, samples 1–30, and warmups 0–5. Map fixtures are capped at 128 MiB. Disk mode
allows 1 GiB without an in-memory full-file fixture or oracle copy: leaves are
generated individually, and validation uses at most 1 MiB ranges. Disk space
must accommodate the fixture plus one sample's new blocks (roughly another file
for sequential write), and any other files already on the volume. Generated
temporary block directories are removed after the campaign or an ordinary
exception. Forced process termination may leave `shared-fs-merkle-bench-*`
directories in the operating system temporary directory.

Every emitted sample includes its raw latency, exact counters, output root hash,
verified byte count, full output SHA-256 and process-memory endpoints. Each final
file is read completely and checked against an independent position-addressable
corpus/patch/truncate/zero model, including EOF. The fixture asserts that every
data leaf has a distinct content ID. Builder `sourceFetches`/`sinkPuts` are
cross-checked against the source/sink, and reader output/fetch counts are checked.
The sequential-write case verifies the final file after all its 1 MiB builds.

Timings sum the individual builder-build/close or reader-read calls. Input
generation, full byte comparisons, hashing of the validation digest, fixture
construction and cleanup are outside the timers. The reported memory values are
process endpoints, not peaks or allocation counts; they include the live fixture.
`--expose-gc` requests GC before each sample, outside timers. Every sample has
fresh builder/read caches, while process and OS caches remain uncontrolled.
Run separate fresh processes and vary matrix order for a larger campaign.

The NDJSON header records platform, Node, resolved crypto/Borsh versions and entry
hashes, source/compiled benchmark input hashes, and the lockfile SHA-256. Resolved
dependency paths describe the code actually loaded. A lockfile hash alone does
not prove that the installed dependency graph matches that lockfile. The final
`complete` event is emitted only after the entire requested sample matrix passes
validation. A missing `complete` event, nonzero exit status or unexpected sample
count means an incomplete campaign, not usable aggregate results. Warmups remain
in the raw output with `warmup: true` but are excluded from percentiles. With
three samples, p95/p99 are simply the maximum; they are descriptive, not a tail
latency estimate.

The next promotion campaign still needs matched flat v9 versus Merkle runtime
storage, Documents publication, mount paths, replication and receipt phases,
large-file and small-file mixes, and Linux/macOS/Windows evidence. This harness
is a bounded algorithm/storage-adapter input to that work.
