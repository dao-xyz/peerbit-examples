# Adaptive content custody: design and bounded experiment

## Status and scope

This is a **test-only split metadata/content-plane experiment**, not a production
shared-fs implementation, wire format, migration, or release recommendation. It
uses independent Peerbit `Documents` collections to test whether content can have
partial, adaptive custody while every participating peer retains the complete
metadata inventory. It does not yet implement a working multiparty filesystem.

The first two corrected campaigns **failed** on the repository's existing older
Peerbit cohort. Adaptive mode demonstrated partial content placement with complete
metadata before failing during a join. Neither mode reached offline recovery;
neither establishes safe redistribution through churn. See the results below.
There were no write retries, timeout increases, or production-default changes.

## Intended production boundary

Keep namespace records, directory relationships, version heads, conflict heads,
tombstones, trust/authorization state, and changeset records fully replicated.
Replace embedded large content with authenticated manifests referring to
content-addressed chunks in an independently replicated content plane. A file's
name or directory must not determine which machine is required to keep its bytes.

The prototype's metadata plane contains only immutable file manifests: file ID,
ordered chunk IDs, aligned chunk lengths, total file length, and a whole-file
digest. It does **not** contain the production namespace, concurrent version
resolution, rename rules, deletion semantics, trust graph, or changeset protocol.
The prototype validates chunk hashes, but that is an integrity check, not an ACL.

Content placement and a client's working cache are separate concerns. A peer can
retain full metadata without holding every chunk. Missing content is fetched and
verified when read; missing, corrupt, or unreachable content must produce an
explicit failure, not an empty file or an invented successful read. Custody policy
must preserve the configured minimum copies independently of cache eviction.

This does not remove the fully replicated metadata ceiling. Every metadata peer
still pays for namespace/version/tombstone/trust histories, indexing, cold-open
work, pending-document drain, and directory enumeration. Metadata checkpoints and
bounded history work remain separate requirements.

## Write and retirement contract

The intended successful write sequence is:

1. Authorize the writer and freeze the operation's content and relevant metadata
   version/authorization context. Produce deterministic chunk and manifest IDs.
2. Write every referenced chunk and obtain actual persisted-delivery receipts for
   its **exact log entry** from at least N distinct capable remote peers.
3. Only after those receipts succeed, publish the manifest/version metadata.
4. Obtain the required persisted metadata receipts before acknowledging the
   operation's remote-durable completion to the caller.

The experiment follows this ordering with a controlled publisher. Its publisher
retains its authored chunks until the explicit retirement phase but never counts
toward custodian coverage. Readiness may be useful preflight; it is not the
durability proof. A local index row, connected peer, leader plan, observed copy,
or completed `put` without the requested receipt guarantee is not interchangeable
with a persisted acknowledgement. Older/unsupported peers cannot satisfy N.

There is no cross-log transaction. A chunk write can commit locally and reach
some remotes before its receipt wait fails. Metadata publication can likewise
commit or become visible before its receipt wait fails. Timeout/cancellation is
therefore an **uncertain completion**, not proof that nothing was written. Never
automatically roll back by deleting chunks, manufacture a successful receipt, or
blindly append another operation on retry.

A production implementation needs persistent operation IDs and reconciliation:
find whether the exact manifest/entry was already committed; authenticate its
contents; resume confirmation of that entry where supported; distinguish a new
log entry from a repeated confirmation; and expose uncertainty to the caller.
Deterministic content IDs help deduplicate bytes but do not alone make multi-log
publication idempotent. Interrupted chunk-first writes can leave orphans. They
must remain recoverable until safe reference accounting and reclamation exist.

Receipts are evidence for particular entries and acknowledgement sessions, not a
permanent promise that N copies survive every later membership change. Before
source retirement, fence mutations and the live metadata/reference set, renew
persisted receipts for all required exact content and metadata entries against
current eligible custodians, and recheck the fence. Concurrent writes, trust
changes, or leader/session changes must prevent retirement until the renewed
proof is valid. The experiment's final barrier re-delivers the actual entries
recorded by successful writes; it is not a production disposal implementation.

Distinct peer keys are not independent failure domains. Multiple identities can
share one disk, host, power supply, administrator, or region. Production placement
must define and validate the required failure-domain separation. The current
experiment provides no such evidence.

## Authorization, confidentiality, and migration

Production manifests and namespace operations must bind content IDs and lengths
to authorized writers and the applicable trust state. Custodians must reject
unauthorized writes and invalid content before admitting them. Reconnect, owner
revocation, stale sessions, and changeset admission need the same fail-closed rules
as the metadata plane. The prototype's single controlled publisher and content
hash predicate do **not** provide these production guarantees.

Decide whether custodians are trusted readers or blind ciphertext holders. Full
metadata replication exposes names, sizes, references, and relationships unless
metadata is separately protected. Plaintext content addressing also reveals
equality and can enable guessing known content. Encryption/key-epoch and
deduplication-domain rules must be explicit; do not silently deduplicate across
unrelated authorization domains. Revocation cannot erase bytes or keys a peer
already learned. Key distribution, rotation, offline recovery, and historical
version access need a specified policy and adversarial tests.

Use an explicit new program/format version and address for any production split
plane. **Existing shared-fs addresses and their interpretation remain unchanged.**
Opening an old address must not silently change replication, mutate its content
representation, or require unsupported clients to interpret new manifests.

A migration should be an explicit authorized operation: preserve the old source,
enumerate and validate its complete live/history/reference set, copy content into
the new format, obtain the new content and metadata receipts, verify independent
reopen/read behavior, and publish an authenticated mapping or cutover receipt.
Retain rollback/read compatibility and the original source until the cutover's
retirement conditions hold. Mixed-version behavior and incomplete migrations
must fail clearly. The prototype's separate run-derived collection IDs only
isolate experiments; they are not that migration protocol.

## Capacity and reclamation

Adaptive mode supplies Peerbit storage limits as **soft log-byte targets**. The
measurement called `localLogBytes` comes from the content log's accounting; it is
not total directory size, live payload bytes, native allocation, or process RSS.
The report keeps unique logical payload bytes, log bytes, process memory, and
post-stop directory accounting separate. They can overlap and must not be added
as if they were disjoint physical storage.

For this experiment, `capacityBytes` denotes a soft **log** budget; use
`logTargetOverageBytes` for target overage. `payloadTargetOverageBytes` is a separate
comparison only. Overshoot and controller convergence are observations to report,
not evidence that a hard disk/RSS quota was enforced. Simulated budget weights do
not create heterogeneous hardware.

Never use shard movement, an absent index row, or a reduced participation setting
as permission to physically delete shared blocks. Physical GC remains fail
closed: an unknown or shared reference domain is insufficient. Inspect the block
store safety contract and do not reclaim unless the required caller-exclusive
ownership and all live-reference, history, in-flight operation, and recovery
conditions are proven. Metadata alone is not enforcement; stores reporting
`enforcedReclamation: "none"` do not provide safe shared-store deletion by fiat.
Even an exclusive domain still needs correct reference accounting. This
experiment retains state directories as evidence and does not test physical GC.

## Bounded methodology

Source is in `library/src/__tests__/adaptive-placement.bench.{test,worker,model}.ts`
and `adaptive-placement-analysis.ts`. The benchmark is opt-in and excluded from
ordinary test execution unless `PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=1` is set.
Select `full` or `adaptive` with `PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_MODE`; run
one separately labeled campaign of each mode using unchanged source.

- Up to five independently initialized local worker processes and distinct state
  directories: one publisher/observer plus custodians transitioning **3 → 4 → 3**.
  Reopens use fresh processes and the same custodian directories/identities.
- N is fixed at **2** for this probe. Production shared-fs currently declares a
  minimum replication degree of **3**; this probe neither changes that default
  nor validates a production N=3 design.
- Deterministic workload: **24 files, 42 unique chunks**, 4,096 bytes per chunk
  (172,032 logical payload bytes). Every fourth file contains four chunks; other
  files contain one. This workload exercises different file sizes, not a measured
  cross-file deduplication benefit; overlapping/repeated chunks have unit tests.
- Both modes fully replicate manifest metadata. Full mode requests complete
  content participation; adaptive mode uses per-custodian log budgets derived
  from a projected content-log size and weights 0.35, 0.60, 0.85, and 1.20. These
  are experiment parameters, not measured device capacities or fitted optima.
- Write the first eight files with three custodians. Continue writes while a
  fourth custodian starts and connects. Require complete metadata and sufficient
  observed custody after the join. Adaptive mode then reduces custodian 1's log
  budget to 75% of its original value and samples again.
- Continue writing while custodian 1 is intentionally killed. Sample the three
  survivors, perform verified repeated reads, renew exact-entry persisted content
  and metadata receipts, and stop the publisher. Then kill the remaining
  custodians and reopen them offline with dialing/listening disabled. Verify
  local chunk hashes, metadata completeness, and aggregate surviving N-copy
  coverage without assistance from the publisher or network.
- Intentional crashes are fault injection, not successful cleanup. Normal stop
  acknowledgement must also be followed by natural exit with code 0. Command
  failure, deadline, cleanup failure, or source-hash drift fails the campaign;
  no write retry or automatic campaign retry converts it to success.

The driver captures phase events, package/module provenance, source hashes,
per-file receipt timings, metadata gaps, residency, participation, resource
snapshots, and cleanup diagnostics. Preserve raw failure events and retained
directories. Record exact lockfile hash, loaded package versions, Node/OS/CPU,
memory, run mode, and source revision alongside results; a lockfile declaration
alone does not prove which module instance was loaded.

Coverage counts distinct custodian identities, excluding the publisher. Report
both chunk-count and unique-byte-weighted coverage, separately for any custodian
and the configured N. Zero denominators remain explicitly unavailable. Missing
metadata is reported independently. Additions/removals are sampled logical
residency differences with joins/leaves explicit, **not measured network bytes**,
physical deletion, or fresh persisted receipts. A short stable inventory window
does not establish long-term controller stability.

These processes share one host, disk, CPU/memory pressure, and local network
environment. They do not test realistic hardware heterogeneity, WAN latency,
bandwidth limits, geographically independent failure domains, or malicious peers.
The experiment makes no hotspot avoidance, bandwidth balancing, fairness,
production throughput, reliable p95/p99, or “fastest filesystem” claim. Repeated
hot reads check availability/integrity and expose timings; they do not implement
or prove a demand-aware placement controller.

## Results ledger

| Campaign                      | Status               | Evidence and interpretation                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earlier full-mode attempt     | Failed before writes | Dial argument-shape harness error; preserve raw evidence; no placement conclusion.                                                                                                                                                                                                                                                                                                                             |
| Corrected full-mode baseline  | **Failed**           | 16 files acknowledged. All four custodians held all 28 published chunks and 16 manifests after the join. During the next file, after abrupt custodian 1 loss, a chunk committed locally but persisted delivery timed out. No cleanup failures.                                                                                                                                                                 |
| Corrected adaptive-mode probe | **Failed**           | 12 files acknowledged. Before the join, custodians held 9, 11, and 14 of 14 published chunks; all held all 8 manifests and every chunk had at least two observed custodian copies. During the fourth custodian's join, a chunk committed locally but timed out waiting for two persisted remote replicas. Joining peer 4 subsequently exceeded the 20-second stop deadline; forced cleanup counted as failure. |

Both modes used unchanged corrected sources, once each, sequentially on
2026-09-05. The initial address-shape failure is retained separately; its fix used
the supported single-string dial API. Neither corrected campaign was retried.
The adaptive budget-reduction phase, final missing-content read, renewal barrier,
source retirement, and offline reopen were **not reached**. A future green run
must finish all those phases and clean up naturally.

Successful whole-file receipt latency was median **139.6 ms**, maximum
**2,987.4 ms** for the full mode's 16 completed writes; median **138.7 ms**, maximum
**4,211.5 ms** for adaptive mode's 12 completed writes. These exclude the failed
operations and mix 4 KiB and 16 KiB files. They are censored observations, not a
speed comparison, tail SLA, throughput result, or evidence of an optimization.
Peer keys/placement are independently randomized between modes. Each file's
chunks and manifest are acknowledged sequentially in this intentionally simple
probe; batching/concurrency tuning is not evaluated.

Full-mode failure: chunk entry
`zb2rhb7J4HhKejDj2nDLxsvhigMuFFdjYQswN4cngVoCqjsRc`, with a
`PersistedDeliveryError` reporting local commit followed by timeout. Custodian 1
exited at 18,170.6 ms; the error arrived at 52,367.4 ms. Failure inventories showed
31 source chunks versus 30 on each of the three survivors, and 16 manifests
everywhere. This is not evidence that the failed chunk was safely replicated.

Adaptive failure: chunk entry
`zb2rhhZuJdPih812Ue7rzxDr8kXBqEHrcSYnF6q85rAnTT9CD`, with a
`PersistedDeliveryError` reporting a timeout waiting for two persisted remote
replicas. Joining peer connectivity completed at 18,634.0 ms; the error arrived
at 38,681.6 ms. Failure inventories showed 24 source chunks, custodian counts
15/18/20/10, and 12 manifests everywhere. These inventories include unpublished
content and do not establish a successful write or safe disposal. Peer 4's stop
deadline failed at 58,694.4 ms. Worker diagnostic tails were empty in both runs.
The current error records preserve the outer message and stack but not nested
`cause` stacks or structured committed-entry fields. Preserve those in a future
diagnostic revision before drawing a protocol-level root-cause conclusion.

### Provenance and reproduction

Base: `b2c9d300deecca240bcd0de322f317fb2475c7f5`. Host: macOS 26.6.2 (25G83),
Apple M3 Pro, arm64, 36 GiB RAM; Node 24.13.1, pnpm 10.26.1. Loaded library
versions: `peerbit@5.3.35`, `@peerbit/document@15.0.16`,
`@peerbit/shared-log@16.0.15`, `@peerbit/crypto@3.1.6`,
`@dao-xyz/borsh@6.0.1`. **These are not the newer upstream release cohort.**
Do not report these failures as regressions in that newer cohort without a
separately labeled coherent-cohort reproduction.

The worktree reused the existing coherent library/root dependency directories
through ignored symlinks. No install or dedupe was run; held upgrade worktrees
were untouched. Worker reports record the actual resolved module paths and entry
and package hashes, not just root package declarations. This is not a complete
hash of all transitive modules or native binaries.

Both corrected reports have these SHA-256 hashes (paths under `src/__tests__`
except the repository lockfile):

```text
adaptive-placement.bench.test.ts    4f0280ecb3446882450839d26661bf9ea2c00af3c3e795e756f811f1b2da50a1
adaptive-placement.bench.worker.ts  ae6be3bae2e0d89167c6899c3a8afe457d827f19367050f63b4f08c0349df966
adaptive-placement.bench.model.ts   af75e38ce540de280b059dceeb9e709c4d7e10a15cbcfe2c7a2844f4f2c48212
adaptive-placement-analysis.ts     9c32d7da884af246dabe21c0f4d8e37ed93c45b7fe9e142ae1f80be5c0213dfe
process-isolated-soak-storage.ts   f3fcbab4d9317b7d9c8952feba3d522fe8b436411767e592ac5fd53402d3592e
pnpm-lock.yaml                    4a4a8df381f6abb29fa12d604a6c8a1b7c5487ed3df6273b7e069422dc475f57
```

From the repository root, with the bot `.envrc` loaded, run each mode separately
and retain stdout/stderr plus the reported state directory:

```sh
PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT=1 \
PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_MODE=full \
pnpm exec vitest run packages/shared-fs/library/src/__tests__/adaptive-placement.bench.test.ts --project node --retry 0 --reporter verbose
```

Use `adaptive` instead of `full` for the other campaign. No extra flags disable
default transports or manufacture clean process exits. The unit analysis tests
run without the opt-in variable; the live experiments are skipped by default.

Raw logs are retained locally under
`/private/tmp/peerbit-performance-20260905/` (not committed to the package).
They include complete machine-readable `placement-event` and `placement-report`
records. Preserve these filenames and SHA-256 values when sharing the logs:

```text
adaptive-data-plane-full-first.raw.log
22357d834df5cdf8fb249563cfd69065c67e883e2a2061e00e0995362436ca4f
adaptive-data-plane-full-corrected-dial.raw.log
b0cefc6bbbe730ccd7ab439590a32fae62a8e4ed080f8a32890d3e02d3f30138
adaptive-data-plane-adaptive-first.raw.log
bb608f8c13cfc7c2a0ee5ad14f37e23cc93b4c688e598b81eac73bbe44a2171b
```

## Outstanding milestones

1. Resolve/rebaseline receipt and shutdown failures on the coherent newer upstream
   cohort without weakening deadlines or retry gates. Complete both labeled probes
   through offline recovery and independently audit actual loaded dependencies,
   receipt evidence, offline identity/connection checks, and cleanup.
2. Specify and test the production format, old-address compatibility, explicit
   migration, operation IDs, uncertain-outcome reconciliation, and orphan policy.
3. Integrate real multiparty filesystem semantics: authenticated concurrent
   writers, version/conflict heads, atomic namespace operations where promised,
   changeset admission, tombstones, snapshots, mounted read/write/fsync behavior,
   and cold-open/pending-drain behavior across both planes.
4. Add production ACL, encryption/key-epoch, owner revocation, and adversarial
   trust/session tests before exposing the prototype to untrusted writers or
   custodians.
5. Demonstrate N=3 and explicit failure-domain-aware placement on separate hosts,
   including insufficient capacity, partitions, simultaneous losses, repair,
   source-retirement fencing, and offline recovery.
6. Measure sustained controller behavior, hard resource exhaustion, bounded
   concurrency/backpressure, read amplification, real transfer bytes, and workload
   tails. Only then evaluate demand-aware placement or bandwidth scheduling.
7. Design reference-safe compaction and physical reclamation without weakening
   version/tombstone recovery or deleting another program's blocks. Continue to
   address the fully replicated metadata scalability limit independently.

None of these milestones is implied complete by this test harness.
