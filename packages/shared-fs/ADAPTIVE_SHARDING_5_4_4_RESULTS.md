# 5.4.4 N=3 first-attempt evidence, 2026-09-07

Both frozen modes fail the first chunk's persisted-delivery request, before metadata publication. Neither completes a whole file. The release gate remains held: this is not a successful adaptive-placement, disposal, restart, or performance result. No retry or repair was performed by the evidence analyzer.

Measured revision supplied by the run owner: `a1198d029ff76e40619af1780d05e79be741e72d`, `/private/tmp/peerbit-n3-5.4.4-20260907`. The seven harness hashes embedded in BOTH new reports exactly match the latest rebaseline reports. The lock hash is `dfa07c924f7a9bd49ccc53d6f81b47747f0de0b41ddfb4a409d324d4e7522752`. Recorded runtime modules agree across all workers: peerbit 5.4.4, document 15.1.4, shared-log 16.0.34, Borsh 6.0.1, crypto 3.1.6; Node v24.13.1, darwin arm64.

## First failures and progression

| Mode     | First failure, scenario ms | Failing operation             | Completed whole files | Natural test exit / wall duration |
| -------- | -------------------------: | ----------------------------- | --------------------: | --------------------------------- |
| Full     |               29667.190625 | `chunks.put`, worker line 275 |                  0/24 | 1 / 31.10 s                       |
| Adaptive |               30258.528333 | `chunks.put`, worker line 275 |                  0/24 | 1 / 31.60 s                       |

Exact inner cause in both: `Timed out waiting for 3 persisted remote replicas.` The enclosing `PersistedDeliveryError` explicitly records `localCommitSucceeded: true`, `retrySafe: false`. Do not replay these writes automatically.

- Full committed **chunk-log entry**: `zb2rher5hnGaEf9nB9cQxVzFpP4ud1LpKXL7VQCGVhgMFSDgF`.
- Adaptive committed **chunk-log entry**: `zb2rhXLghiVD6pskYpyk2CDwRCe2h2oRfTegfvV67JyWNFJzP`.

The worker sends one file per command, sequential chunk puts with persisted `minAcks: 3`, 20,000 ms delivery timeout and 25,000 ms command signal; metadata is published only after all chunk puts return their receipts. The first failure inventory contains just the first 4,096-byte fixture chunk, ID `f198b08babd33540a0b9bb87684413416712d549beb84dfe8f314b1c12c211f6`, on the publisher and all four custodians in both modes. Every metadata inventory is empty. Thus the first chunk's N=3 acknowledgement operation did not complete; no later chunk or metadata receipt completed. The actual number of partial remote acknowledgements is **not recorded**, and indexed residency is not receipt or crash-persistence proof.

The only event types are `ready` (five workers), `failure`, `failure-inventories`, and `shutdown-diagnostic`. No sample phase, steady placement, peer-5 join, leave, source disposal, offline reopen, or survivor-read phase was reached. The test is a split-plane Documents fixture, not a complete sharded filesystem. These failures occur earlier in the workflow, but later in wall time, than the previous failures below.

## Exact identity / plane mapping

These are the publisher/observer and **candidate** custodians from the recorded identities. The frozen report does not contain observer-to-remote receipt readiness, current session, subscriber, capability, eligible-leader, selected-recipient, or acknowledgement-count snapshots. It cannot prove which candidate was eligible or counted. Connection counts are connections, not distinct remote receipt peers.

Full chunk plane: `zb2rho72FyTxuZtMqJRgaGu18kwjBGraWtHmL58HPFA9maJnt`.
Full metadata plane: `zb2rhnRuLjuGCKhb4rSAUQvVcyJzcnZjn5Px2jZuZmp8yDAeF`.

| Peer                  | Full identity hash                             |
| --------------------- | ---------------------------------------------- |
| 0, publisher/observer | `G0x7MVfOGFK8ZlMMaxnF4trwdwijLAQ6dc1NfI4ISF4=` |
| 1, candidate remote   | `3vp2FMylrzJrB7gWtScOUvIrXgHGVolku5G0m216pOs=` |
| 2, candidate remote   | `olfBYixpOc/AWISMO51mCVDdv1RcWYvu/P3kWjdj9qU=` |
| 3, candidate remote   | `3sNF7xzfOPtEi0lsNhSh1bAmrQgzv9chbrmB5edvze0=` |
| 4, candidate remote   | `BAEVHvNBr1hTiLvexDoB+r/GzjVdkAbW5WBqwCUeFnU=` |

Adaptive chunk plane: `zb2rhnn8Jxa1AWzz4BKnCwYjyRAee9f4264xHHASFLQipLfGy`.
Adaptive metadata plane: `zb2rhiMiLEFThX5bjZGY4nwmd2KEUqAAkHxKGwJ9KLipKtwJN`.

| Peer                  | Adaptive identity hash                         |
| --------------------- | ---------------------------------------------- |
| 0, publisher/observer | `aMsVhyMbDwOu+hHVQ9xQG8x3v2ZcmSvadUtDfiQiIUI=` |
| 1, candidate remote   | `fwknDs9mzaatQITaL6aqqYoOr5lh2M+Fy/BOlRUeHnk=` |
| 2, candidate remote   | `gzBQtF7u4bXZtX/So5taxNRY05jbDSb6WomJ55YI6I8=` |
| 3, candidate remote   | `tBe2RojuY54Ar+iz6DgNW98NZZmc+PCh1z7zcMEiAGY=` |
| 4, candidate remote   | `lmb8pjGel++oaz+NIR4SWVlVkfxjvoLgS+pXvT0EAfM=` |

## Bounded profile evidence

Failure-inventory aggregates contain 786 events full / 1,910 adaptive across five workers and two planes, with zero invalid/dropped events and no saturation. These totals are one snapshot per worker/plane, not duplicated first-failure plus inventory aggregates.

- Full maximum recorded immediate-leader-plan span: 19.309 ms; join-plan span: 1.242 ms. No join-plan sample crossed the 1,000 ms sample threshold.
- Adaptive maximum immediate-leader-plan span: 64.436 ms. Peer 1's chunk `sharedLog.receive.joinPlan` produced one 1,466.004709 ms sample: entries/count 1, immediateReplicatingLeaderPlanHits 0, immediateReplicatingLeaderPlans 1, nativeSynchronousJoinPlan false, nativeAllKeptJoinPlan false. No sample drop or invalid field was recorded.

No dedicated receipt wait/count or readiness failure span is present. These bounded, possibly nested phase timings do not explain the 20-second receipt timeout or establish a causal leader-planning regression. No peer stderr tail contains an additional recorded receipt/readiness error; omitted tail characters are zero.

## Comparison: latest same-day rebaseline, not the older report

Previous cohort recorded peerbit 5.4.2 / document 15.1.2 / shared-log 16.0.32. Both latest previous first attempts reached worker line 289 (`metadata.put`) after four chunk puts had returned their persisted receipts for `/file-0.bin`, then failed metadata delivery with `No peers found for topic ...`. This four-receipt count follows the frozen sequential worker control flow and four-chunk source manifest; the harness does not emit individual receipt records. Both had zero completed whole files, `localCommitSucceeded: true`, `retrySafe: false`, and no sample phase.

| Previous mode | First failure ms | Failed metadata committed entry                     | Topic                                          |
| ------------- | ---------------: | --------------------------------------------------- | ---------------------------------------------- |
| Full          |      7643.362375 | `zb2rhfFUn5vFYcaoiPDZXt3DeD3m34p9gHLWMdRgzEtimWuMe` | `wlW4Sb6JP9AQWzHUlN0Wvjj+OwQ8jcHVqz2Hfof8yxk=` |
| Adaptive      |         7710.011 | `zb2rhmbGfL3vVgJ1WZ6Df8UxpftSe44sz1x5fvX3pzU96cK8k` | `FrDgqgHJTDxpx3g+ub41juLJHJfA33meo4L6m+aAJ74=` |

The new attempts do not reach the previously failing metadata path, so they cannot establish that old metadata failure is fixed. Nor do two different first-attempt outcomes isolate a particular upstream commit as causal.

## Shutdown and process absence

Every new worker received exactly one stop command, returned `peer.stop: fulfilled`, replied, and had an observed OS exit code 0 with null signal. No shutdown event or tail omission; no checkpoint, escalation, stop retry, or cleanup-error event was recorded. Full stop-command-to-exit range: 1,175.079–1,218.486 ms; adaptive: 1,129.455–1,150.544 ms. These include stop, snapshot/disk scan, IPC and process exit, not just `peer.stop`.

- Full PIDs: 93676, 94086, 94320, 94581, 94850.
- Adaptive PIDs: 15079, 16082, 16891, 17694, 18380.

Read-only `ps -p` on precisely these ten PIDs returned no rows (exit 1) at 2026-09-07T20:49:12Z, confirming current absence at that observation. The run owner also confirmed all full workers absent before launching the separate adaptive attempt. No test was retried.

## Immutable inputs / replayable analysis

| Raw file in `/private/tmp`                                     |  Bytes | SHA-256                                                            |
| -------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `peerbit-cohort-5.4.4-20260907-n3-full-first.raw.log`          | 214437 | `de57c0a80fe7a29a406e7f8e6e01ae05d06e7d7730c53057629dff466963fbeb` |
| `peerbit-cohort-5.4.4-20260907-n3-adaptive-first.raw.log`      | 221962 | `5e29a8969fbecaf7e71f082d19cca8ba9bcf315d845a792d1e278f9544f64b72` |
| `peerbit-cohort-rebaseline-20260907-n3-full-first.raw.log`     | 207902 | `cfcbbf1ba6d9e6265eb04b78aa053889c6c3794e705fe3ef8339e3183a8c24c4` |
| `peerbit-cohort-rebaseline-20260907-n3-adaptive-first.raw.log` | 228444 | `2ca4392efbd3fb549a344cd55fcf82d204c687e2ea6259fa2295a277f69e20b4` |

The latest old audit `/private/tmp/peerbit-cohort-rebaseline-20260907-n3-audit.json` SHA-256 is `8ee85fbf4934750e03be140c2ebbcffc226f74c6547a0f80245c791eecc7aae6`; its two raw hashes match the independently read previous raw files. No older workload result is used in this comparison.

Recompute bounded extraction with `node /private/tmp/peerbit-cohort-5.4.4-20260907-n3-analysis.mjs`. It imports only Node builtins, reads the four raw logs plus latest old audit, checks seven harness hashes, and prints selected evidence. It does not import Peerbit, modify files, signal workers, retry a workload, or invoke readiness/repair APIs.

## Downstream execution scope

The measured commit changes only the four existing library pins and generated
lockfile relative to the previous frozen N3 checkout. Root and library
`node_modules` are ignored links to the one plain 5.4.4 cohort installation;
there was no second install, dedupe or installed-source patch. All 49 existing
analysis/plan/telemetry/stop-trace unit cases passed before the two live runs.

The two live commands selected the historical Vitest configuration, with
`--retry=0` and no per-test retry override in this driver. They did not select
the separate strict reporter; no strict-instrumentation count is claimed for
these N3 samples. The ordinary library/CLI matrix is separate evidence:
[draft PR #351](https://github.com/dao-xyz/peerbit-examples/pull/351) passed
[its three-OS strict run](https://github.com/dao-xyz/peerbit-examples/actions/runs/34160359522)
on the same cohort. That success does not clear these experimental failures.

Full state directory: `/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-full-tWxSD9`.
Adaptive state directory: `/var/folders/72/dk60kcw10b52qqc0bj_yz2tm0000gn/T/peerbit-placement-adaptive-uUqNZO`.
Both remain retained. No source disposal or physical reclamation was performed.

The next diagnostic is a separately labeled revision, never a replacement for
these failures: inspect each explicit candidate's actual public key on the
writer's chunk log and separately on its metadata log, passing only
`{ diagnostics: true }`. Record the exact committed entry as contextual evidence
on the matching plane, not as a getter argument. Keep every inspection owned
through cleanup, without a recovery waiter, write replay or deadline extension.

Upstream corrected the earlier exact-entry proposal: supplying `entries` invokes
fresh leader planning that can query providers, warm subscriber caches and do
index/planner work. It is **not** strictly passive. A future exact-entry probe
must be labeled active planning, use the corresponding log's actual entry and
total leader-plan degree, and never reuse a chunk entry for another log. The
public getter has no signal/timeout option. Peer-only inspection can memoize an
opaque generation; its status and attached diagnostics are not atomic.
Readiness cannot substitute for persisted receipts.
