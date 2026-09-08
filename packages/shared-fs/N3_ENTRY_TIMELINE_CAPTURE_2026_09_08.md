# N=3 targeted capture: fourth chunk times out after three successful puts

The one user-authorized, upstream-coordinated full-mode capture failed naturally.
It produced four distinct per-entry observations: three fast successful chunk
puts, followed by one 20.08-second persisted-delivery failure. No metadata put or
whole file completed. The peer-only failure hook also captured all eight requested
remote/plane snapshots. This is new failure evidence, not a fix, successful
adaptive-placement result, or clearance of the release gate.

## Frozen scope

- Measured commit: `abd62bcc2513c97ec8f3982b57e90daee80c6f35`.
- Checkout: `/private/tmp/peerbit-n3-entry-timeline-20260908`.
- One full-mode N=3 attempt with `PROFILE`, `ENTRY_TIMELINE` and `PEER_READINESS`
  enabled; `--retry=0`. No adaptive follow-up or outcome-driven rerun.
- The [timeline implementation](./N3_ENTRY_TIMELINE_2026_09_08.md) previously
  passed 104 focused tests, with strict typechecking, lint and formatting.
- Unchanged coherent install: peerbit 5.4.4, document 15.1.4, shared-log 16.0.34,
  crypto 3.1.6 and Borsh 6.0.1; Node 24.13.1, pnpm 10.26.1, darwin arm64.
- Lock SHA-256: `dfa07c924f7a9bd49ccc53d6f81b47747f0de0b41ddfb4a409d324d4e7522752`.
  All ten source/lock hashes embedded in the report still matched after the run.
  Installed runtime entry hashes matched the preceding diagnostic before launch.
- No new install, source override, active entry-planning probe, recovery waiter,
  write replay, altered transport, increased deadline or physical reclamation.

Upstream deferred heavy workloads during this capture. It separately reproduced
a routing shortcut omitting young intersecting owners, but no causal link from
that bug to this failure is established. This capture used the released cohort,
not the unpublished routing fix. Short upstream deterministic tests and other
host activity were not controlled as a performance benchmark.

## Exact write sequence

All four records belong to publisher generation 1, command request 2, file 0,
chunk log `zb2rhZ2Wy795pDVnxbYyYWeJiWNmdwBBtqSq5AyeMHKicb5aD`.
Each chunk is 4,096 bytes and each put requests persisted `minAcks: 3` with the
original 20,000 ms delivery timeout and shared 25,000 ms command signal.

| Chunk part | Outcome                     | End-to-end put ms | Exact committed log entry                           |
| ---------- | --------------------------- | ----------------: | --------------------------------------------------- |
| 0          | Fulfilled                   |        121.201959 | `zb2rhnFCgRoEfozsgmpUydd39m3xyHDFQvJbW3sA6Qh6pPvXA` |
| 1          | Fulfilled                   |         63.397750 | `zb2rhbFkM7taS7weSwe2kZun5BMiva6jpnmV6Afu5QWdhnB7i` |
| 2          | Fulfilled                   |         74.063375 | `zb2rhkgt1pBoXoFFAA2RZfXt9gHgHMmeCf3aNa3u5GxX8fZ5o` |
| 3          | Rejected after local commit |      20083.196459 | `zb2rhkkXqRPybdJMwRPQqSJRYpRwJUwmxKe32CGsWGBLeXZUH` |

Failed chunk document ID:
`66129e6f50706d0d5e6cc92ff8f7006d88d1601ae72d506ffe110057a42b50a6`.
The exact outer error is `PersistedDeliveryError`, with
`localCommitSucceeded: true`, `retrySafe: false` and that committed entry hash.
Its cause is `Timed out waiting for 3 persisted remote replicas.` No automatic
retry is safe merely because the caller saw an error.

The failure came from `chunks.put` at measured worker line 385, before metadata
publication. The publisher's recorded invocation/result times for part 3 are
8,588.457958 / 28,671.654417 ms on `writer-process.performance.now`. These are
end-to-end put and command-rejection-checkpoint times, not isolated receipt-wait
spans. The full nested error and stack remain in the raw first-failure record.

There are no successful whole-file `write-receipt` events, so a report looking
only at those events would miss the three successful puts. The first-failure
profile and failure inventories retain the four-entry timeline, with zero invalid
or omitted records. Repeated snapshots must be deduplicated by publisher
generation and sequence, not counted as additional puts.

The scenario stopped before the later peer join/loss, file 16, final barrier,
publisher disposal or offline reopen. It therefore **does not answer** whether
the preceding successful run's file-16 10.789-second aggregate was one slow put or
several, nor explain its 9.643-second first metadata put. It directly establishes
one individually slow failed put in this distinct capture.

## Peer-only observations after failure

Observer: `vYCJmk1VYaYAEYVPoZWA+UQmtZT4TAA56UNZgj7OTQE=`.
Metadata log: `zb2rhWjAtaAsDegvMNRHex23tRaCDtTwHTqo2CaDrWC14mrnG`.

| Remote peer / generation | Remote identity hash                           | Chunk readiness | Metadata readiness   |
| ------------------------ | ---------------------------------------------- | --------------- | -------------------- |
| 1 / 2                    | `q5yVXaRrd7WybCAtfdEmTpqD9iHXURtD2+erRkT48R8=` | Ready           | Pending confirmation |
| 2 / 3                    | `wcgYK18N2rVqmy0k6OPaWEzaLsYWw5bAJJraeW8bWDQ=` | Ready           | Pending confirmation |
| 3 / 4                    | `Xve4LDzNOnIIyyNQY9IVESpAnPlqxXSq8/4hjZLrEjc=` | Ready           | Pending confirmation |
| 4 / 5                    | `QjNMsqLF9Kpk5NosveD1pFgRuQXt72vsk82mhQNFu0w=` | Ready           | Pending confirmation |

All eight getter calls fulfilled, in 0.909–0.946 ms each. Invocations were at
writer time 28,706.629–28,706.769 ms, roughly 35 ms after the recorded put failure;
results were at 28,707.574–28,707.691 ms. These observations are **after failure**,
not continuous evidence of readiness throughout the attempted write.

Shared across all eight snapshots:

- Log open; session current, open, established and not suspended; no opening
  barrier or replication-info block; receive cleanup gate open.
- Observed capabilities include persisted receipts and replication confirmation.
- Receiver current/active, request idle, last applied sequence `1`, advertisement
  ready; recorded request/advertisement/rearm attempt and outstanding counts zero.

Chunk sender snapshots say `latest-applied`, with current/applied revision `1`,
zero confirmation waiters and zero retry attempts. Metadata snapshots instead
say `pending` / `replication-confirmation-pending`, sender `latest-unconfirmed`,
current revision `1`, no applied revision, zero confirmation waiters and zero
retry attempts. No metadata put had been attempted, so that pending state must
not be presented as the cause of the chunk failure.

Each getter received only the actual remote public key and `{ diagnostics: true }`.
The failed entry hash was context on the chunk plane only; `entries` and `replicas`
were not passed. The observations are non-atomic and advisory. They do not prove
fresh exact-entry leadership, selected recipients, an acknowledgment count, or
crash-safe storage of the failed put. Ready peers cannot substitute for the
persisted receipt that timed out.

## Inventory, profiling and process cleanup

At the failure inventory, the publisher and all four custodians each indexed all
four chunk documents, zero metadata, and four connections. This is unverified
indexed residency (`verifiedLocalChunks` is null), not a persisted receipt or an
offline verification. Connection counts are not acknowledgment counts.

One failure-inventory snapshot per worker/plane totals 862 profile events, with
zero invalid/dropped events and no saturation. The largest sampled receive-side
join-plan span is 1.169 ms; immediate leader plan is 12.795 ms. These observations
do not explain the writer's 20.08-second end-to-end failed put. No additional
`NotStarted`, unhandled-error or warning marker was found outside the expected
failure output.

The test returned natural exit 1: 29.93 s test body, 30.10 s runner duration.
Every worker received exactly one stop command, fulfilled `peer.stop`, replied,
and exited naturally with code 0 and null signal. Stop-command-to-exit spans were
1,166.365–1,188.690 ms; no stop retry, escalation or omitted shutdown/tail evidence.

PIDs 10740, 10901, 10908, 10910, 10911 were all absent in the read-only check at
2026-09-08T06:21:32Z. No source was deleted. Retained state directory:
`/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-full-ukUsl6`.

Raw log: `/private/tmp/peerbit-n3-entry-timeline-20260908-full-targeted-first.raw.log`,
250,965 bytes, SHA-256
`93a57a6bc80bb79e55d19efafb8f5d63ee3d90c272cb7b7063f58dee1f8f011b`.
It contains the complete profile, readiness, error, source and process provenance.
The historical Vitest configuration was used; no separate strict-reporter count
is claimed for this live diagnostic.

## Independent extraction

Two independent reviews agreed with the failure, readiness and cleanup findings.
A standalone Node-builtins-only analyzer reads one bounded raw log and prints
evidence without importing Peerbit, querying stores, signaling processes or
replaying the workload:
`/private/tmp/peerbit-n3-entry-timeline-20260908-analyze.mjs`.
Its final SHA-256 is
`bd2a114125fc0642a8bdd331553e16681e49b6a1d8065522a9c92cfbd557eb52`.

The final analyzer reconciled 12 record copies from three snapshots into four
unique publisher-generation/sequence spans: no contradictions, unassigned sources,
invalid records, omissions or analysis warnings. As a negative control, the
preceding passing diagnostic explicitly produced `missing-diagnostic` and zero
entry records, rather than inventing per-entry timing from its file aggregates.
These are read-only reanalyses, not extra live attempts. Two earlier display
labels were corrected before the final analyzer checks: absent receive-plan spans
are null rather than zero, and probe counts explicitly refer to capture events.

- Final analysis JSON: `/private/tmp/peerbit-n3-entry-timeline-20260908-final-analysis.json`,
  SHA-256 `1b1432a3734e362f49d4f288136f8645d834dd93919408c4ce47176b2d37acdb`.
- Negative-control JSON: `/private/tmp/peerbit-n3-entry-timeline-20260908-negative-analysis.json`,
  SHA-256 `85a65fb00fc9a8cf69516eacdc9e909e7e8e1e5059a51920abb82e5e955d2f2a`.

## Decision and upstream handoff

The exact failure, entry identities, timings, post-failure readiness, raw hash and
clean shutdown were sent directly to the upstream task. Their next investigation
can distinguish selected/eligible leaders and receipt-attempt progression without
mistaking post-failure peer readiness for entry durability.

Keep the earlier full/adaptive failures and the separately passing full-mode
sample intact. Do not replay this locally committed failed put, rerun simply for
green, merge/release the held cohort or claim adaptive recovery. No further live
run was launched after this result.
