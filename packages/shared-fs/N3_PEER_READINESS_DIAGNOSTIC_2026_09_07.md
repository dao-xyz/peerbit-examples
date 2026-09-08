# N=3 peer-only diagnostic: one successful full-mode sample

The separately labeled diagnostic completed naturally with exit 0. All 24 files
received persisted delivery, the final 66-entry N=3 barrier completed, and four
crashed custodians reopened offline with all expected chunks and manifests.
There was no failure, so the failure-only readiness getter was **not invoked**.
This sample does not explain or clear the two frozen 5.4.4 first-chunk receipt
failures in [the original report](./ADAPTIVE_SHARDING_5_4_4_RESULTS.md).

## Measured scope and inputs

- Measured commit: `302cd13ed125744ecb0f7196a3858f9b4c9a8e69`.
- Checkout: `/private/tmp/peerbit-n3-peer-readiness-20260907`.
- One full-mode sample; no adaptive diagnostic run or workload retry.
- Node 24.13.1, pnpm 10.26.1, darwin arm64; independent processes on one host.
- Recorded modules on all ten worker generations: peerbit 5.4.4, document
  15.1.4, shared-log 16.0.34, crypto 3.1.6, Borsh 6.0.1.
- Lock SHA-256: `dfa07c924f7a9bd49ccc53d6f81b47747f0de0b41ddfb4a409d324d4e7522752`.
- Root/library dependency directories reuse ignored links to the one coherent
  5.4.4 installation. No second install, dedupe or installed-source patch.

This revision changes test diagnostics, not production implementation or
dependencies. The driver, worker and model differ from the frozen original
failures; a new helper is added. All nine embedded measured source/lock hashes
still matched the checkout after completion. The runtime module hashes also
match the frozen 5.4.4 samples. This is not a matched performance comparison.

## Diagnostic contract

`PEERBIT_SHARED_FS_ADAPTIVE_PLACEMENT_PEER_READINESS=1` enables a once-per-writer
inspection only at the existing failure checkpoint. The parent uses already
received, current-generation, online remote candidate identities. The writer
deserializes each actual public key and verifies its hash before inspection.

The helper inspects at most five remote candidates on each of the writer's two
relevant logs: chunks and metadata. Each call receives only
`{ diagnostics: true }`; **no entries or replica degree** are supplied. A failed
write's exact committed entry hash is contextual evidence on its matching plane,
never a getter argument or an entry reused for another log. No trust log exists
in this fixture.

Each record contains observer/remote hashes, remote generation, log address,
monotonic invocation/result times, elapsed time, and snapshot or bounded error.
The helper settles every issued inspection, including on clock faults. The
existing worker queue owns the command through cleanup. The existing five-second
parent IPC observation bound does not detach the worker operation; an unfinished
operation would retain the original stop/exit failure deadlines. Original
failure evidence is preserved separately from any diagnostic error.

This is peer-only, non-atomic, advisory inspection. It can memoize an opaque
generation, and status/diagnostics are sampled across an await. It is not a
recovery waiter, fresh entry-leader plan, write replay or durability proof.
Exact-entry inspection would be active planning and is deliberately excluded.

## Completed phases and limits

The scenario used one publisher and 4 → 5 → 4 custodians, 24 files, 42 unique
4,096-byte chunks (172,032 unique payload bytes), and persisted `minAcks: 3`.
All original workload, delivery, command and cleanup deadlines remain unchanged.

1. All 24 file write commands completed persisted chunk and metadata delivery.
   Per-file chunk timing aggregates sequential chunk puts; individual receipt
   payloads/acknowledging identities are not separately recorded.
2. A fifth custodian joined while writes continued. The first custodian was
   deliberately killed while the final group of writes proceeded.
3. Eight hot reads on peer 5 verified assembled file content before the final
   crash, including repeated reads of file 0. All were local hits.
4. At scenario 59,891.482 ms, the final persisted barrier recorded 42 chunk
   entries plus 24 metadata entries, requiring three remote acknowledgements per
   entry; the barrier took 197.738 ms.
5. The publisher stopped gracefully. All four surviving online custodians were
   deliberately killed, then reopened sequentially with networking disabled.
6. Each offline peer 2, 3, 4 and 5 verified all 42 local chunk hashes/lengths and
   all 24 exact expected manifests. All had zero connections and empty advertised
   addresses, retained their identity hashes, and had no missing metadata or
   below-N chunk. Four observed copies per chunk survived.

Offline verification checks chunks and manifests; it does **not** perform 24
separate reconstructed offline-file reads. This is a test-only split-plane
Documents model, not a mounted sharded filesystem or a multiwriter benchmark.
The full mode neither exercises adaptive budget changes nor proves partial
content placement. Publisher state was retained, not physically reclaimed.

There are zero failure, failure-inventory, readiness-capture or cleanup-error
events. Because the diagnostic branch was never entered, this live sample does
not validate real getter IPC capture on failure or reveal prior missing receipts.

## Latency observations, not a speedup

- First file: 10,509.954 ms total, including 9,642.718 ms metadata receipt time.
- File 16, concurrent with custodian loss: 10,916.514 ms total, including
  10,789.047 ms aggregated chunk receipt time.
- Last received initial-custodian ready event: scenario 20,728.152 ms. Startup
  scheduling differs from the frozen samples; no cause or observer-effect size
  was isolated.
- Test body: 71.739 s; runner duration: 72.16 s, natural exit 0.

Last sampled profiles per worker generation total 7,353 events, with zero invalid,
dropped or saturated aggregates. The largest sampled join-plan span is 12.826 ms;
no retained join-plan sample crosses one second. These profiles do not establish
the cause of either receipt tail. Success does not make the approximately
ten-second stalls acceptable or establish reliable latency percentiles.
Nested/overlapping profiles and repeated cumulative snapshots must not be summed
as wall-clock critical paths. No network-byte, heterogeneous-hardware, long-run
storage-growth or scaling claim follows from this single full-mode observation.

## Process ownership and retained state

Publisher PID 83937 and offline PIDs 85424, 85518, 85705, 85917 each received one
stop command, fulfilled `peer.stop`, replied and exited naturally with code 0.
Online custodian PIDs 83973, 84005, 84034, 84082, 84289 each exited with the planned
`SIGKILL`; these crashes are not counted as graceful cleanup. No shutdown events
or stderr-tail characters were omitted. Read-only checks on exactly these ten
PIDs showed no remaining processes at 2026-09-07T21:20:56Z and independently at
21:21:40Z. No stop retries, cleanup escalation or forced-success exit occurred.

Retained state directory:
`/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-full-toMJ1r`.
Nothing was deleted or reclaimed.

## Validation, including tooling failures

The first focused-test invocation selected a strict config absent from this
historical experimental checkout: startup exit 1, zero collected/executed tests.
Its raw log is preserved. The corrected historical-config invocation passed 71
tests, including 22 new diagnostic cases, with `--retry=0`. No failed test case
was retried; no separate strict-instrumentation count is claimed here.

The first explicit TypeScript command combined `--strict` with
`--noImplicitAny false`, producing three `never[]` errors for existing scratch
arrays. Removing that weakening override passed strict typechecking without
changing runtime source. Both logs are retained. ESLint and formatting also
passed. These checks cover driver/worker/helper and focused pure tests, not a
new production or three-OS N=3 matrix.

Raw logs share `/private/tmp/peerbit-n3-peer-readiness-20260907-`:

| Suffix                           | Outcome                               | SHA-256                                                            |
| -------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `pure-first.raw.log`             | Startup failure, no tests             | `356552e1dd894155280a81cbdf07242db27217898221d05163edf562bcd1a887` |
| `typecheck-first.raw.log`        | Three type errors                     | `111934a41938647b245b7de2158ea0654b0d84f22fac10bb9a435c0548f1f5dd` |
| `pure-historical-config.raw.log` | 71 tests passed                       | `948775b8f1f7e7296ba8bc7d2df0a7a202ea5d92a5bfe17b2aa2952e8df4b0ac` |
| `typecheck-strict.raw.log`       | Exit 0, empty log                     | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `lint-first.raw.log`             | Exit 0, empty log                     | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `format-first.raw.log`           | Formatting passed                     | `17aa973d3f004560237d9a95171210b0671deff23d61628eecf7322ff5938f20` |
| `full-diagnostic-first.raw.log`  | One live test passed; 2,407,323 bytes | `8370b0361b08aba3a899981a6c90155b78b0f137ae0cd6ebefac6d0da2cbc719` |

## Decision

Keep the original full/adaptive failures visible and the release gate held.
Do not merge or release the cohort based on this different diagnostic revision's
single passing sample. No further run was launched to obtain a failure or green
result. Upstream received the exact raw evidence and latency observations; the
next useful capture needs a distinct hypothesis, with receipt proof and cleanup
requirements unchanged.
