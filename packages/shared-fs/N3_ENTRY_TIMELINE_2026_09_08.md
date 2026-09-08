# Bounded per-entry write timeline

This is a test-only diagnostic, not a protocol fix or a new benchmark result.
The preceding full-mode diagnostic succeeded but recorded a 10,789 ms aggregate
for one file's four chunk puts. The aggregate cannot identify the slow chunk.
The earlier full/adaptive receipt failures remain unresolved and preserved in
[the original evidence](./ADAPTIVE_SHARDING_5_4_4_RESULTS.md); the separate passing
sample is documented in [its own report](./N3_PEER_READINESS_DIAGNOSTIC_2026_09_07.md).

## What changes

The explicit `PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_ENTRY_TIMELINE=1` flag enables
a synchronous, publisher-only recorder. It requires the existing
`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PROFILE=1` checkpoint facility. Neither flag
by itself enables the opt-in live workload.

The recorder surrounds each original awaited `chunks.put` and `metadata.put`.
It retains at most 128 records, enough for this fixture's 42 chunk puts and 24
metadata puts. It does not record document payloads, keys, entry objects or
closures. Fields include:

- Stable sequence, parent command request, file number and chunk part where
  relevant, plane, document ID and log address.
- Logical chunk/file payload bytes (not serialized operation or network bytes).
- `requestedMinAcks`, explicitly not a measured acknowledgment count.
- Invocation and result timestamps on `writer-process.performance.now`, elapsed
  time, and pending/fulfilled/rejected outcome.
- The returned committed log entry hash on success, or a small, detached subset
  of the existing sanitized failure evidence on rejection. The existing full
  error/cause report remains authoritative.

Successful command replies contain only that request's records. Existing profile
and failure checkpoints expose the full bounded history, including a pending put
when the command queue is stalled. Repeated snapshots are cumulative: identify a
record by worker generation and sequence; do not add copies of the same span.
Writer-local timestamps cannot be directly subtracted from another worker's or
the parent scenario's clock without an explicit clock-origin mapping.

Settlement timing is sampled before the original result entry access and the
diagnostic hash read. The result entry is still accessed exactly once, with its
original error propagation; a one-shot hash recorder binds to the settled span.
Rejection timing is sampled at the existing command rejection checkpoint,
not at an internal protocol event. Diagnostic clock/hash/extraction errors are
visible through counters and cannot turn a fulfilled write into a rejected write
or replace the original error. Unknown timings/hashes stay unknown. Overflow
keeps the first records and counts omissions; it never overwrites earlier failure
evidence or settles an old record on a later command's behalf.

## What stays unchanged

The awaited puts, returned entries, write order, persisted delivery options,
shared command signal, failure propagation, peer-only failure hook, final barrier,
transport, topology and cleanup deadlines remain unchanged. There is no new
promise wrapper, timer, listener, readiness/planning call, recovery, delivery call,
write retry or IPC round trip on the put path. Only the existing result replies
and profile checkpoints carry the additional evidence. Synchronous collection,
hash access, snapshot copying and larger existing replies still add observer
work; this is not a claim of zero overhead or identical scheduling.
The pre-existing per-file aggregate timings include synchronous recorder work;
the per-entry settlement timestamps precede entry/hash extraction. Reply-local
record subsets carry cumulative collector counters, not per-command counters.

All changes live under the library's test directory and this documentation.
The existing TypeScript build excludes `src/__tests__`, and the package files
list excludes both source and emitted test directories. No production source,
package declaration or lockfile changes, dependency installation, physical
deletion or reclamation are needed.

## Limits and next decision

The installed public `Documents.put` result exposes an entry and removed entries,
not per-peer acknowledgment counts or timestamps. A fulfilled put with persisted
delivery is the public API's success, not a separately observed receipt packet.
Its elapsed time includes document preparation/indexing, append, planning and
delivery. This timeline cannot separate receipt wait from leader planning,
storage, local materialization or other work within the put.

Do not add document change listeners to infer commit time: those listeners can
enable additional materialization work. Do not use private local-commit hooks or
replace a persisted put with separate append/delivery operations. Receive-side
join-plan profiles do not explain the writer's receipt stall by themselves.

The purpose of a future, explicitly labeled capture is to determine whether the
large aggregate comprises one slow put or several and to supply its exact plane,
chunk and committed-entry context. Upstream is separately examining leader degree,
remote acknowledgment requirements and receipt-attempt timers. No live run is
requested by this change; repeated runs to obtain a green result would not
resolve the frozen failures. The release gate remains held.

## Local validation

Work is isolated in `/private/tmp/peerbit-n3-entry-timeline-20260908`, branch
`test/shared-fs-n3-entry-timeline-20260908`, based on documentation head
`96262b3b9928d8fe4603915c4b48e1553ed79d01`. The dependency directories reuse the
existing coherent 5.4.4 install. The unchanged lock SHA-256 is
`dfa07c924f7a9bd49ccc53d6f81b47747f0de0b41ddfb4a409d324d4e7522752`.

The first helper run passed 31 tests, and the first combined run passed 102.
Review added two cases for worst-case JSON escaping and preserving a single
original entry access/error; the final combined run passed **104 tests**, including
**33 timeline cases**. The two live scenarios were explicitly disabled and
skipped. All test invocations used the historical Vitest configuration with
`--retry=0`; no per-test retries or separate strict-reporter counts are claimed.
No live Peerbit process workload was launched.

Strict TypeScript, ESLint and formatting checks passed. The first expanded
TypeScript check found TS2339 in the new test fixture: `Object.defineProperty`
did not add `entry` to its inferred `{}` type. A typed object-literal getter fixed
the fixture; no implementation, runtime deadline or assertion was weakened.
The original failed command's log remains preserved. The lint command chained
after that failed typecheck did not run; it subsequently ran after the corrected
typecheck and passed. An independent review found no remaining blocker.

Logs below share `/private/tmp/peerbit-n3-entry-timeline-20260908-`:

| Suffix                             | Outcome                          | SHA-256                                                            |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `helper-first.raw.log`             | First 31 helper tests passed     | `5c0add3fc0c79cbac4366c5b9b8af253d2647571ef36b476092bc6f0f190f080` |
| `focused-first.raw.log`            | 102 passed, 2 live cases skipped | `eac8093f54d086ab47560b32621c385e982ad217b0306f2f46c97aeefbced35b` |
| `focused-expanded-first.raw.log`   | 104 passed, 2 live cases skipped | `7dd646085a0d7453012f106f4e8fe2c6bf10ad8d925c107ab471145f24a91975` |
| `typecheck-expanded-first.raw.log` | TS2339 in the new fixture        | `d0319e63a6abf2e64fd0a9dc74657114bad603f4365743f492f1c9dfe87ebe96` |
| `focused-final.raw.log`            | 104 passed, 2 live cases skipped | `73e5129710af6b864fb0ab5a51ce74679278d82c48a888c53f2acf8cd606a02e` |
| `typecheck-final.raw.log`          | Exit 0, empty log                | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `lint-final.raw.log`               | Exit 0, empty log                | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The full/adaptive first-failure raw hashes and the separate passing diagnostic's
raw hash were rechecked and still match their frozen reports. Those worktrees,
the original user checkout and the cohort PR are unchanged. This validation
establishes recorder behavior and type-safe integration, not real-network IPC
capture, a receipt-liveness fix, adaptive recovery or improved performance.
