# Write readiness v2: prove catch-up instead of waiting out a timer

Status: design for owner review, revised after a 25-finding review (see "Review
notes" at the end), then revised again on 2026-10-05 after a benchmark of six
proof mechanisms (section 11.1). That revision replaced the proof mechanism:
salted `u64` lists and per-session RIBLT became a maintained coded prefix plus
a set hash. The M0 probes ran on 2026-10-05; section "M0 results" lists what
they changed, and **D3 is back with the owner** (K0 fired). Nothing is
implemented. Code refs: `origin/master`
`2fd4f64b` (0.16.5, Peerbit 5.4.10, `@peerbit/shared-log` 16.0.40,
`@peerbit/document` 15.1.11). `src/index.ts:N` is
`packages/shared-fs/library/src/index.ts` (16,859 lines). `@peerbit/<pkg> file.js:N`
is the installed dist under `packages/shared-fs/library/node_modules`. Evidence
lives in `~/git/shared-fs-evidence/readiness-design-20261004/` (called
`evidence/` below), `~/git/shared-fs-evidence/unblocked-20261003/quiet-window/`
and `~/git/shared-fs-evidence/readiness-sota-20261005/` (called `sota/` below).
D1-D18 are the owner decisions in section 12.

This document picks one of four candidate designs and grafts parts of the other
three onto it. Section 11 has the candidates and their review scores.

## 1. Decision memo

**The question.** Write readiness ends with a fixed 5 s quiet window
(`WRITE_READINESS_SETTLE_MS`, `src/index.ts:2410`). The owner asked whether
something more rigorous than a timer can make correctness likely.

**The answer in one paragraph.** Yes, for every peer the joiner can see; no
local mechanism can do it for peers it cannot see. A joiner J asks each visible
peer R for a snapshot of R's namespace. R answers with a count and a set hash
of its entry hashes (the anchor), plus a few kilobytes of coded cells that
tell J which entries differ. J then waits, driven by events, until
its index holds every entry in that snapshot or J can show why it never will
(J holds a later entry that supersedes it, or J rejected it). J proves this by
recomputing R's set hash from its own rows; the cells only guide the search,
so they cannot make J ready by mistake. This is
containment: J's state then dominates R's state at snapshot time, so J's next
write cannot needlessly conflict with anything R held. Containment survives R
leaving and stays reachable while R keeps writing. J becomes ready when every
connected or live visible peer is contained (or caught in a provable lie), and
at least one of them was a ready full replica in the very answer J contained.
A timer can bound a request; its expiry alone never makes J ready. Peers J
cannot see (offline laptops, the stale-creator case, a lost Subscribe with no
other traffic) stay outside the promise, as they are today. The difference is
that the promise now says so and the persisted proof shows who was checked.
Signed writer frontiers can narrow that gap later, for access-controlled stores
only.

**Why change it.** The timer is not only slow. It is also wrong in both
directions:

| Finding                                                             | Measured                                                                                                                        | Source                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Plain dial of a 1-file store: every prerequisite met, then waiting  | prerequisites at 0.23 s, writable at 5.34 s (n=6)                                                                               | `quiet-window/README.txt`, `results.ndjson`                             |
| A colleague saving every 1 s keeps a new machine read-only          | not ready after 30 s or 60 s; CLI mount fails at its 120 s default                                                              | `evidence/correctness-model/zz-starve*.out`; `cli/src/index.ts:889-893` |
| The window certifies partial views at 6k files                      | ready at 62-97 s (n=4) with 5,846/6,060 naming and 5,783/6,000 version rows, and 5,872/5,779 in another run (counted in 2 runs) | `evidence/semantic-safety/results.ndjson`                               |
| A wrong "ready" is not loss-free                                    | an equal-bytes save is silently lost; a `mkdir` splits a directory; a stale edit can win                                        | `evidence/correctness-model/zz-staleview.out`; `src/index.ts:6651-6669` |
| The prototype of this design                                        | 1 file 0.31 s, 400 files 0.95-0.99 s, donor writing every 1 s 0.66 s                                                            | `evidence/upstream-sync/reconcile-run2.out` (in-process, section 6)     |
| The chosen mechanism, cross-process over one-way RPC (M0 P5, n=20)  | 1 file p50 0.28-0.36 s (today 5.45-5.49 s); donor writing every 1 s p50 0.82-0.93 s, 20/20 ready (today 0/20)                   | `evidence/m0/p5/README.md` (section "M0 results")                       |
| The proof mechanism chosen on 2026-10-05 (simulated WAN, 100k rows) | rejoin with nothing missing: 64 ms, 388 B, 1 round trip; 1,000 missing: 426 ms, 87.5 kB, 3 round trips                          | `sota/c4/out/table-arms-wan.md` (microbenchmark, section 6.1)           |

**What changes.**

- A new readiness RPC program on the filesystem, with versioned one-way
  messages and a new store salt. This is a format break with no migration (D5).
- Every peer keeps two small structures over its namespace rows, updated on
  each write: the first 4,096 cells of a rateless IBLT (180 KB) and an
  LtHash32 set hash (4 KB), plus a map from document id to current head
  (about 13 MB at 200k rows). Measured in the product's change tap (M0 P4),
  the anchor's cost grows with heap size, so it runs in a worker thread; the
  main thread then pays about 2-6 µs per row change (p50). All three are
  persisted across restarts (D15, D17).
- The quiet window, the 1 s re-check poll, the 100 ms double check, the
  "remote evidence" flag and its profile-event capture, and the private read of
  `syncronizer.pending` all go (`src/index.ts:10161-10188`, `10314-10471`,
  `3412-3480`). The readiness fence stops reading route hints. Bootstrap
  discovery and the GC peer gate keep their private `pubsub` reads until M2
  (section 4.11).
- There is no index column, no salt per responder and no per-session encoder.
- Readiness persists a proof (peers contained, peers excluded and why, gaps).
- Scheduled GC requires write readiness. `allowPartialWrites` never arms Guard
  D. Both are gaps in today's contract (section 3).
- Who is gated does not change: creators and warm reopens are writable at once.
  Observers and partial replicas stay read-only. The mount still returns
  `EAGAIN` while gated.

**Why this base.** The upstream-aligned snapshot design scored highest overall
(7.2 of 10 averaged over three reviews). It is the only candidate with a
measured end-to-end prototype. Its element identity is the log entry hash, the
same thing Peerbit reconciles, so a future upstream reconcile call replaces
the session code instead of the design. It adds no index column. We wrapped it
in the stricter readiness rule of the digest design. We also added fixes that
no candidate had: a connected or live peer that has not answered keeps J gated,
and its late answer still counts; only a provable lie excludes a peer, never a
timeout; and an entry in J's own log that supersedes a listed head (a CUT or a
later put) explains that exact head.

**Why this proof mechanism (2026-10-05).** We benchmarked six mechanisms on the
same harness at 10k, 100k and 1M rows (section 11.1). A maintained prefix of
rateless IBLT cells over full entry hashes, checked by an LtHash set hash, was
the fastest sound option that needs no unreleased upstream work. It sends
388 B on a rejoin with nothing missing and about 88 kB for 1,000 missing rows,
at any store size. The donor spends 0.07-4.9 ms of CPU per session. Salted `u64` ids
and per-session `@peerbit/riblt` lost on cost and failed an injected
collision test (20 of 20 false readies); the anchor makes a collision a delay,
never a wrong ready. The end state is the same structure inside shared-log
(U-36), shared by sync and readiness.

## 2. Definitions and guarantees

### 2.1 Terms

| Term            | Meaning                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Namespace row   | A `NamingEvent`, `FileVersion` or `ChangesetManifest` in the entries index. Not `FileChunk` or `BootstrapManifest`.                                                                                                                                                                                     |
| Trust row       | A row of the `TrustedNetwork` trust graph (access-controlled stores only). It lives in a separate log, `trustGraph.log`.                                                                                                                                                                                |
| Entry           | The log entry behind a row. Identified by its hash (`__context.head`), which covers the row bytes and the signature.                                                                                                                                                                                    |
| Element         | The full 32-byte entry hash. No salt, no truncation.                                                                                                                                                                                                                                                    |
| Snapshot S_R(t) | The set of elements of every live namespace (or trust) row of R at one epoch, frozen at time t_R. R freezes it by copying its cells and anchor.                                                                                                                                                         |
| Live row        | A row in the scope's index. A row leaves the live set when a CUT or a later put of the same document replaces it.                                                                                                                                                                                       |
| Anchor          | R's LtHash32 set hash of its live rows: 1,024 lanes of 32 bits, each element expanded to 4 KB and added lane-wise mod 2^32. D_R = sha256 of the lanes at the snapshot.                                                                                                                                  |
| Cells           | The first M = 4,096 coded cells of a rateless IBLT over the live rows. A cell is the XOR of 32-byte hashes, the XOR of a keyed 64-bit checksum, and a count (44 B). They are a hint: they say which elements differ, never whether J is done.                                                           |
| Contained       | Every entry of S_R(t_R) is indexed by J (J's index of that scope has a row whose `__context.head` is that entry), or is explained. `Log.has` alone is not enough: the log commits before the index (`@peerbit/log log.js:3756`, `3785`).                                                                |
| Explained       | J will correctly never index it: J's log of that scope holds an entry whose `meta.next` includes it (superseded), or J's `canPerform` rejected it under the rules of section 4.6.                                                                                                                       |
| Visible         | Subscribed to the readiness topic, or listed by the scope log's `getReplicators()`.                                                                                                                                                                                                                     |
| Connected       | A readiness-topic subscriber that is reachable on the route table now (`pubsub.routes.isReachable`, re-read on libp2p `peer:disconnect` / `peer:connect` and fanout `peer:unreachable`). Pending D3: M0 P1 found that pubsub never drops a dead subscriber on its fanout parent (section "M0 results"). |
| Live            | A visible peer that is not connected but has sent J something since J opened: a replication announcement (`replicator:join`, `replication:change`), a readiness message, or a subscribe. A peer whose readiness Subscribe was lost (U-1) but whose replication traffic arrives is live.                 |
| Qualified donor | In the `HeaderV1` of the session that J contained, R reported `writeReady`, a source in {creator, reconciled, warm, operator} (M2: `warm-fresh` instead of `warm`), a full replica, the same format, and, in access-controlled stores, an identity in J's trusted set. A notice never qualifies.        |
| Required        | The connected and live visible peers at the moment of evaluation, plus any peer with a session in flight, plus any `left-unanswered` peer (section 4.7). Never frozen.                                                                                                                                  |
| Dominance       | Every naming and content head in S is in J or is an ancestor of a row in J. Containment implies dominance. Every needless conflict type comes from a write that ignores an existing head (correctness map §2).                                                                                          |

### 2.2 What "ready" proves after this change

When a fresh address-open of a full replica turns `writeReady` with source
`reconciled`, J has proven, locally:

1. **Containment.** For every peer R in a set C, J indexes or explains every
   entry of S_R(t_R). t_R is no later than R's receipt of J's request. The
   evidence is an exact set-hash match:
   `sha256(LtHash(S_J) − LtHash(X) + LtHash(E)) == D_R`, where S_J is J's
   live rows, X ⊆ S_J is J's rows that R's snapshot lacks, and E is rows J
   explains. This holds only if (S_J \ X) ∪ E = S_R, unless someone found an
   LtHash32 collision (section 5).
2. **Every connected or live visible peer is accounted for.** At the moment of
   the decision, every Required peer is in C, or excluded for a provable lie
   (a recovery list whose count or set hash differs from R's own signed
   header, or a hash R's cells or list named whose fetched entry is not a row
   of that scope), or has left (recorded in `gaps` when J still lacked its rows,
   D4). Silence, `BUSY`, slowness and fetch timeouts never exclude a Required
   peer. M0 P1 showed that pubsub does not reliably drop dead subscribers, so
   "left" is read from route reachability instead (pending D3). A hung peer
   whose sockets stay open never leaves; it keeps J gated until the caller's
   timeout.
3. **Non-vacuous.** At least one peer in C qualified in the `HeaderV1` of the
   same session that J contained. A `StateNoticeV1` from a peer that J
   contained while that peer was gated only starts a new session with it, so a
   peer's later state never certifies its earlier partial snapshot. An empty
   visible set never yields ready.
4. **Trust first.** In access-controlled stores, J contained the trust scope
   of every peer in C before any row counted as explained by trust, and before
   any donor's identity was checked against the trusted set. Each peer freezes
   its trust snapshot after its namespace snapshot in the same session, so the
   trust view J checks against is no older than the rows the peer listed. An
   untrusted rejection stays provisional: it is re-checked whenever J's trust
   graph changes or C grows.
5. **Bootstrap.** The phase is `off` or `converged` (unchanged).
6. **Durable.** The proof was fsynced before memory flipped and before any
   write was admitted (unchanged order, `src/index.ts:10260-10305`).

Consequence: J's later writes cannot conflict needlessly with any state a
contained peer held at its snapshot. The proof is monotone, because J's state
only grows and GC retires only rows that have a retained descendant
(`src/index.ts:15985-16027`). So the proof stays true after a donor leaves.
Readiness chains: a qualified donor was itself proven, or created the store.

### 2.3 What "ready" does not prove

| Not proven                                                                                                            | Why                                                                       | What we do                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Rows held only by peers J cannot see (lost Subscribe with no other traffic, U-1; offline writers; stale creator, U-7) | No local mechanism can see them                                           | Stated in README; `writersUnheard` telemetry; optional frontier layer (M4)                                                               |
| Rows any peer received after its snapshot                                                                             | Snapshot semantics; such writes are concurrent with J by definition       | Normal sync and conflict handling                                                                                                        |
| Rows of a peer that became visible only after ready                                                                   | The decision is made at one moment                                        | Same as above                                                                                                                            |
| Rows of a peer that left before answering and never came back                                                         | J never learned its set                                                   | Recorded as `gaps: {peer, missing: "unknown"}` (D4)                                                                                      |
| That a peer told the truth                                                                                            | Under-reporting looks like a lagging donor                                | Every Required peer must be contained, so one liar wins only if it is alone                                                              |
| That chunk bytes are present                                                                                          | A write needs chunk ids, not bytes                                        | Reads wait for chunks, as today                                                                                                          |
| Freshness of a warm reopen                                                                                            | Warm reopens trust their persisted proof (offline-first)                  | M2 freshness check and `warm-fresh`; opt-in `requireFreshOnReopen`                                                                       |
| GC safety                                                                                                             | Not readiness's job; arrival-age shields protect GC (at least 1 h to 2 d) | Unchanged; scheduled GC also gated on readiness now                                                                                      |
| Revocation enforcement                                                                                                | J cannot tell pre-revocation history from later writes                    | Unchanged (README "trust")                                                                                                               |
| That a revoked grant stays revoked at a fresh J                                                                       | A fresh J never receives a revocation CUT for a grant it never held (P3)  | A stale peer can re-introduce the grant until a CUT holder re-offers the CUT (about 1 s while connected); stated in README and the proof |
| Write-path losses E1 (equal-bytes save) and E2 (mode/mtime-only change)                                               | These come from the write path, not from readiness                        | Separate fix (D9)                                                                                                                        |

### 2.4 Scenarios: today vs proposed

| Scenario                                                       | Today (5 s window)                                                           | Proposed                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Plain dial, 1-file store, idle donor                           | 5.34 s, measured                                                             | p50 0.28-0.36 s, p95 0.43-0.53 s, measured cross-process (M0 P5, n=20 per batch)                |
| Donor saving every 1 s                                         | never; mount fails at 120 s                                                  | p50 0.82-0.93 s, p95 1.13-1.81 s, measured cross-process (M0 P5)                                |
| A visible peer crashes (`kill -9`) before answering            | not applicable                                                               | leaves within 4-24 ms on the transport event; `left-unanswered`, then `gaps` (pending D3)       |
| A visible peer hangs with its sockets open                     | not applicable                                                               | stays Required; gated until the caller's timeout, which names it as reachable and silent        |
| 6k-file join                                                   | ready at 62-97 s (n=4); 3-4% of namespace rows missing in the 2 runs counted | ready only when every row of every Required peer is indexed (73-99 s today for the whole store) |
| Donor holds only the genesis manifest, both call `bootstrap()` | about 5.7 s (5 s discovery deadline)                                         | same in M1; under 1 s estimated in M2 (decision on a complete answer)                           |
| Busy live creator plus a stale warm replica, both visible      | ready once arrivals pause for 5 s, may miss the creator's rows               | gated until the creator answers and is contained, however late                                  |
| Same, but the creator's readiness Subscribe was lost           | same                                                                         | same as above while its replication traffic arrives (it is live)                                |
| An unanswered peer's connection flaps                          | not applicable                                                               | still Required (`left-unanswered`); a new session when it is back                               |
| Donor leaves after J caught up                                 | gated (needs a live replicator)                                              | ready (the proof is monotone)                                                                   |
| Only another gated joiner visible                              | can satisfy the "live replicator" check                                      | gated; contained but never qualifies                                                            |
| Only partial replicas (factor < 1) visible                     | a partial replica satisfies the check                                        | gated                                                                                           |
| No peer visible, fresh join                                    | gated                                                                        | gated; `assumeComplete()` is the explicit operator escape                                       |
| Identical populated store, no proof on disk                    | gated until some remote put arrives                                          | ready after one answer                                                                          |
| Truncated or lost answer                                       | not applicable (no answers)                                                  | never ready on it: the set hash cannot match without every row                                  |
| Rejoin after a short outage, 100k rows, 10 rows missing        | transfer + 5 s                                                               | about 0.13 s, 1.9 kB, 2 round trips (simulated WAN)                                             |
| Stale-creator / lost Subscribe with no other traffic           | wrong ready possible                                                         | wrong ready possible (non-guarantee, now persisted in the proof)                                |
| Warm reopen after weeks offline                                | writable at once                                                             | writable at once; counts as donor labelled `warm` (M1), `warm-fresh` only after a check (M2)    |
| Joiner still gated when scheduled GC first runs (5-95 min)     | GC may run on an unproven view (`src/index.ts:13963`)                        | scheduled GC waits for readiness                                                                |

## 3. Today's contract

A fresh address-open of a full replica (`replicate: {factor: 1}`) is readable at
once. Every mutation gets `SharedFsWritePendingError` (`EAGAIN`, retry-safe;
`src/index.ts:1473-1489`, thrown at `9862-9866`) until two checks 100 ms apart
both see all of the following:

| Part                  | Code                                      | What it prevents                                             | Weakness                                                                                                           |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| (a) Remote evidence   | `src/index.ts:2412-2421`, `3412-3480`     | an empty or unreachable join certifying itself               | one row is enough; no completeness; reads diagnostic event names                                                   |
| (b) Decision settled  | `src/index.ts:10393-10396`, `10477-10510` | writing during a snapshot overlay or an unverified bootstrap | `unverified` costs at least 10 minutes (`12380-12444`)                                                             |
| (c) Live replicator   | `src/index.ts:10190-10246`                | an unrelated non-replicating peer satisfying the fence       | any replication row counts: a gated joiner or a partial replica; reads private route hints                         |
| (d) Synchronizer idle | `src/index.ts:10161-10188`                | deciding while a known sync is running                       | private state; idle by default between donor pushes at 0/1/3/7/15/30/60 s (`@peerbit/shared-log index.js:517-538`) |
| (e) 5 s quiet window  | `src/index.ts:2410`, `10414-10450`        | deciding in a gap between donor pushes shorter than 5 s      | anchored at open start; restarted by every arrival (starves); shorter than the 8 s and 15 s donor gaps             |
| Cadence               | `src/index.ts:10322-10325`                | n/a                                                          | a 1 s polling loop until (a)-(d) hold                                                                              |
| `markWriteReady`      | `src/index.ts:10260-10305`                | a crash between "ready" and persistence                      | none (kept)                                                                                                        |

The code calls this a "settled-view heuristic" (`src/index.ts:2401-2409`).

Two adjacent gaps found while mapping the contract:

- Scheduled GC is gated by bootstrap phase, not by readiness.
  `gcSchedulerTickInner` (`src/index.ts:13963`) skips
  `assertSafeMaintenanceReady` (`9868-9876`). The first scheduled run fires
  5-95 min after open: 5 min plus up to a quarter of the 6 h interval,
  uniformly (`computeGcFirstDelay`, `src/index.ts:327-330`, `364-368`, called
  at `13881-13887`); the ±20% jitter applies only to later ticks. A joiner
  still gated then can plan GC on an unproven view. Arrival-age shields limit
  the damage. There is no test.
- With `allowPartialWrites`, a bootstrap fallback, a verified retirement or
  quiescence arms Guard D on a partial view (`setGuardArmed(!writeReadinessRequired)`).
  There is no test.

## 4. The design

### 4.1 Overview

```text
every peer, always, per scope, from the change tap (main thread 2-6 µs p50 per row change, M0 P4):
  idHead[id] = head (replace: old head out, new head in; verified against the index)
  cells[0..4096) ^= hash, checksum, ±1      worker: anchor[0..1024) ±= AES-256-CTR(key = hash)

J opens (fresh, full replica, gated)
  │
  ├─ subscribe readiness topic; list visible peers (subscribers ∪ replicators)
  │
  ├─ per Required peer R (≤ 4 sessions in flight; one-way directed messages):
  │     OpenV1{count_J, hlcProved, above_J} ──► R copies cells + anchor (the snapshot, < 1 ms)
  │     ◄── HeaderV1{count, D_R, hlc, above_R} (+ the first cells when the gap is small)
  │     set hashes match ──► contained in 1 round trip
  │     gap > 256 while sync delivers, or > 2,800 ──► wait for Peerbit sync to shrink it (arrival events)
  │     peel R's cells − J's cells ──► R\J hashes (drain by events, else join(hashes))
  │                                    J\R hashes (into X)
  │     explained R\J hashes (superseded / ignored-older / rejected) ──► E
  │     contained ⇔ nothing pending ∧ sha256(LtHash(S_J) − LtHash(X) + LtHash(E)) == D_R
  │     mismatch ──► re-peel; one fresh session; then the exact hash list (recovery)
  │     provable lie → excluded; fetch failed → retried on R's next sign of life or arrival
  │
  └─ evaluate() after every event:
        phase ok ∧ every Required peer contained, excluded for a lie, or left
        ∧ some contained peer qualified in its own header ∧ trust scopes contained
        → persist proof (fsync) → flip → arm Guard D → write:ready → StateNoticeV1
```

The cells are a hint channel and the anchor is the certificate. A wrong hint,
from a collision, a bug or a lying peer, can only delay readiness. Only a set
hash that matches R's signed D_R makes R contained.

### 4.2 Scopes and elements

| Scope          | Rows                                              | When                                 | Log                                                                                         |
| -------------- | ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `NAMESPACE_V1` | `NamingEvent`, `FileVersion`, `ChangesetManifest` | always                               | the entries log                                                                             |
| `TRUST_V1`     | `TrustedNetwork` relations                        | access-controlled stores (`rootKey`) | `trustGraph.log`, a separate `Documents` (`@peerbit/trusted-network controller.js:180-200`) |

Every per-scope operation uses that scope's log and index: `Log.has`,
`join`, `getReplicators`, change events and the superseded lookup.

Excluded, with reasons:

- `FileChunk`: bytes, not namespace. A write needs chunk ids, not bytes.
- `BootstrapManifest`: a per-author discovery record with a stable id
  (`bootstrap:<authorKey>`, `src/index.ts:4152-4155`) that is re-put by design.
  It is not namespace state, and bootstrap discovery has its own rule (#376).
- Delete entries: a delete J lacks leaves J with an extra row. That is harmless
  for containment.

`ChangesetManifest` is included. Its id is content-addressed
(`changeset-manifest:<sha256 of the payload>`, `src/index.ts:4194-4195`,
`7449`), so it is never re-put and cannot stall containment. Including it
means `changesetStatus` and `awaitChangeset`, which read manifests from the
index (`src/index.ts:10724-10750`), see every turn a contained peer held at its
snapshot (D16).

The element is the full 32-byte entry hash:

- **Entry hash, not document id.** A re-put of a stable id with new bytes is a
  new entry, so it is required (skeptic finding b). J checks the index row's
  head, so re-puts are neither missed nor counted twice. This is the identity
  Peerbit itself reconciles, so U-36 later swaps the transport, not the
  semantics.
- **Full width, no salt.** The earlier draft truncated a hash salted per
  responder open to 64 bits. That made J re-hash its whole store under every
  peer's salt (about 0.7 s per peer at 1M rows) and let one collision hide a
  row: an injected collision gave 20 of 20 false readies
  (`sota/c1/out/adv.ndjson.gz`, list arms). With full hashes nothing is derived on the write
  path, a decoded cell is a hash J can pull at once (no resolve round trip),
  and nothing changes when R restarts. Hiding a row now needs an LtHash32
  collision (section 5).
- **Whole hashes cross the wire only when needed.** Cells carry XORs of hashes,
  44 B per cell. A hash travels whole only in a pull or in the recovery list
  (32 B per row).
- **A set, not a multiset.** LtHash cancels an element added 2^32 times, so the
  tap adds a head only when the index row's head changes. The index holds one
  row per document, so the live set has no duplicates.

The genesis manifest stays, for bootstrap discovery (#376). It is no longer
readiness evidence: an empty donor answers `count: 0` explicitly.

### 4.3 Wire format and versions

The filesystem gains `@field({ type: RPC }) readiness`, an `@peerbit/rpc`
program (`@peerbit/rpc controller.d.ts:45-84`). The store salt changes from
`/shared-fs/v9.1` to `/shared-fs/v9.2` (`src/index.ts:2868`). Together they
change the address, so an old client cannot attach (D5).

**One-way messages.** Every message travels with
`rpc.send(message, { to: [peer] })`, a directed `SilentDelivery`
(`@peerbit/rpc controller.js:321-349`). The handler returns nothing. We do not
use `rpc.request`: it deletes its resolver when the request settles
(`controller.js:662`) and drops a late `ResponseV0` silently
(`controller.js:273-279`), so a slow peer's answer would be lost and the peer
would look silent forever. With one-way messages J matches answers by
`sessionId` and accepts them whenever they arrive while the session is open.
The RPC's query type is the union of all messages below (`send` carries only
that type, `controller.d.ts:73`). R's identity is the authenticated signer of
the message.

Every message is a Borsh variant with `version: u8 = 1`, the scope, and that
scope's log id (the entries log for `NAMESPACE_V1`, `trustGraph.log` for
`TRUST_V1`). A message with an unknown variant or version, or a log id that
does not match its scope, gets `ErrorV1{UNSUPPORTED}` or is dropped. It is
never read as empty.

| J to R                                                                           | R to J                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OpenV1{sessionId[16], scopes, attempt:u8, count:u32, hlcProved:u64, above:u32}` | `HeaderV1{sessionId, scope, provenance, count:u32, anchor[32], hlc:u64, above:u32, cells[≤480]}` per scope | every attempt of one session gets the same snapshot; `anchor` is D_R; `hlc` is the highest `__context.modified` (entry wall time, u64 ns) in the snapshot; `above` counts rows newer than J's `hlcProved` on each side; R pushes the first cells when 0 < gapEst ≤ 256 (4.5 step 4); `TRUST_V1` is frozen after `NAMESPACE_V1` |
| `CellsReqV1{sessionId, scope, from:u32, to:u32}`                                 | `CellsV1{sessionId, scope, from, cells[]}`                                                                 | 44 B per cell (32 B XOR of hashes, 8 B XOR of checksums, 4 B count); at most 4,096 cells (180 KB) per session                                                                                                                                                                                                                  |
| `ListPageV1{sessionId, scope, offset:u32}`                                       | `ListV1{sessionId, scope, offset, hashes:[32][≤2,048], done:bool}`                                         | recovery only (4.5 step 10); 64 KiB pages; checked against the header's count and anchor                                                                                                                                                                                                                                       |
| `CloseV1{sessionId}`                                                             | none                                                                                                       | frees R's state early                                                                                                                                                                                                                                                                                                          |
| any                                                                              | `ErrorV1{sessionId, code: BUSY \| UNSUPPORTED \| EXPIRED \| SCOPE}`                                        | explicit refusals; `BUSY` promises a `StateNoticeV1` when capacity frees; `EXPIRED` makes J open a new session                                                                                                                                                                                                                 |
| none                                                                             | `StateNoticeV1{openNonce, provenance, reason}`                                                             | sent with `to:` each peer that had a session or a `BUSY` with R in this open (at most 256), when R becomes ready or `warm-fresh`, or frees capacity                                                                                                                                                                            |

There is no resolve message: a peeled cell yields an entry hash, and J pulls
it with `SharedLog.join`. The cell format is our own and is not
wire-compatible with `@peerbit/riblt` (D17).

A `StateNoticeV1` is only a trigger. J drops a notice whose `openNonce` differs
from the one of its session with R (R restarted; that is a new peer state), and
a notice never makes R qualified. Only the `HeaderV1` of a session J contains
can.

`ProvenanceV1` = `{formatTag: "shared-fs/v9.2", writeReady, source, fullReplica,
phase, openNonce[16]}`. `source` is one of none, creator, reconciled, warm,
warm-fresh, operator, partial-override. `fullReplica` is true when R's own
segments have `widthNormalized == 1`. `openNonce` changes on every open, so J can
tell a restarted peer from a slow one.

Answers are capped at 256 KiB. A peer that sends more is `inconsistent`.

### 4.4 Maintained structures and responder rules

Every open replica keeps three structures per scope, whether gated or not,
because it needs them to answer and to join (the id map was added after M0
P2(c) and P4):

- **Cells.** The first M = 4,096 cells of a rateless IBLT over its live rows,
  as in Yang, Gilad and Alizadeh (section 11.1). A cell is the XOR of 32-byte
  entry hashes, the XOR of a keyed 64-bit checksum of each hash, and a count:
  44 B, so 180 KB for M = 4,096. An element touches the cells chosen by the
  paper's index map, about 15 cells at M = 4,096 (estimate). The walk is driven by a PRNG with at
  least 64 bits of state, seeded from the checksum. A 32-bit seed failed 4 of
  20 decodes at d = 40k. The checksum key comes from the store address. It is
  public on purpose: the anchor carries the security, so the cells need no
  secret.
- **Anchor.** An LtHash32 set hash: 1,024 lanes of 32 bits (4 KB). An element
  is expanded to 4 KB of AES-256-CTR keystream, keyed by the entry hash itself,
  with a fixed IV per scope as the domain tag, and added lane by lane mod 2^32.
  A removal subtracts. Measured 2.10 µs per element in isolation (D17). In
  the product process the same expansion costs 2.6-7.6 µs and grows with heap
  size (6.4-7.7 µs at a 477 MB heap, 20-52 µs at 1.9 GB), because every
  expansion allocates a 4 KiB external buffer (M0 P4). ChaCha20 and BLAKE3
  allocate the same way. So the anchor lives in a worker thread, fed batches
  of 32-byte digests (2.2-2.9 µs per element at any main heap size).
- **Id map.** A map from a document-id hash to its current head, so a replace
  can subtract the head it replaced. Compact form (open addressing on a
  64-bit id hash, plus a slab of 32-byte digests): about 57-63 B per row,
  12.7 MB at 200k rows and 57 MB at 1M (measured; a `Map<string,string>` is
  175-243 B per row).

**Upkeep from the change tap.** One cell walk and one anchor update per added
or removed row. A CUT emits `removed`. A replace emits only `added`
(`@peerbit/document program.js:3390-3432`, primitives map A6), and the new
entry does not reliably name the head it replaced: a `unique` put carries
`meta.next = []` (`program.js:2065`, `2090`), and shared-fs makes such puts
on most paths (`src/index.ts:4390`, `5970`); a remote fork names its own
parent (M0 P2(c), P4). So the tap reads the old head from the id map, not
from `meta.next` (that rule is dropped). Rules from M0 P4, each one a test:

- Scope rows by class (`instanceof NamingEvent`, `FileVersion`,
  `ChangesetManifest`), never by `value.kind`: `kind` is a plain initializer
  (`model.ts:196`) and is absent on removed values, remote arrivals and
  Guard D re-puts.
- Read `__context` synchronously in the listener; the event value can be the
  caller's object, which a later put mutates.
- Ignore empty change events (ignored older arrivals and CUTs with no row
  dispatch `{added: [], removed: []}`).
- **Replace verify.** Documents can dispatch the event of an older entry after
  the event of the newer one that the index kept (concurrent same-id writes,
  `program.js:3912`); a tap that trusted event order diverged in 4 of 4
  two-peer runs. On every replace or stale removal the tap re-reads that id's
  indexed head (serialized, with a per-id version so a newer event retries)
  and reconciles map, cells and anchor. That made 3 of 3 runs match a fresh
  build, at 57-78 µs per verify, async, on replaces only.
- Attach before `entries.open()` starts ingesting, as `freshOpenListener` does
  (`src/index.ts:3487`), or build from a scan while queueing events and apply
  them under the idempotent and verify rules.
- Feed the cells 32-byte digests. Decoding the head string with base58btc
  costs 2.0-2.6 µs; a fixed-shape decoder for these CIDs costs 0.37-0.45 µs
  with 0 mismatches over 50k real heads.

The tap is idempotent: it compares the id map's old head with the new one, so
a re-delivered event changes nothing (50 of 50 skipped). Cost per row change,
p50 at 50k-200k rows: 5.5-15 µs for an add and 9.5-35 µs for a replace with
the anchor inline; 1.8-2.6 µs and 3.2-5.6 µs on the main thread with the
anchor in a worker (M0 P4). That is 0.2-0.8% of `writeBatch` time per file.

**Seed and restart.** A peer persists its cells, anchor and id map at clean
close, next to the sidecar, and deletes the file when the store opens. The
order is: detach the listener, drain writes and Guard D re-puts, then write;
a snapshot taken before `peer.stop()` missed late Guard D re-puts. Restoring
cells and anchor took 0.08-0.78 ms and the map 57-131 ms (as text at 204k
rows; about 8 MB in the compact binary form), against a rebuild of 2.0-4.0 s
at 204k rows (projected scan 1.1-2.2 s plus build 0.9-1.8 s) and 0.45-0.55 s
at 54k (M0 P4). A crash leaves no file, so the next open always rebuilds. A
request that arrives during the rebuild waits for it. A shadow check in tests
compares the maintained structures with a fresh build after every session
(K2).

**Responder rules.**

- Every opened replica answers, gated or not, full or partial, and reports its
  provenance honestly. A warm reopen reports `warm`, not the source it
  persisted.
- **Snapshot.** R copies its cells and anchor lanes at one epoch and hashes the
  lanes: D_R = sha256(lanes). It also records its live count and `hlc`, the
  highest `__context.modified` among its live rows (the entry's wall time in
  u64 ns; tracked on insert, so it never decreases). Every row in S_R has a
  timestamp at or below `hlc`. With the anchor in a worker, the freeze is a
  sequence-numbered request for the lanes at a point in the tap's stream:
  p50 52-167 µs, p99 0.39-6.8 ms round trip at 50k-200k rows (inline it was
  p50 16-31 µs). Every session opened at the
  same epoch shares the copy. t_R is the freeze time. With both scopes, R
  freezes `TRUST_V1` after `NAMESPACE_V1`. Later writes change R's live
  structures, never the snapshot.
- **First flight.** OPEN carries J's count and its row count above
  `hlcProved`. R computes the same gap estimate J will (4.5 step 4) and, when
  it is between 1 and 256, sends the first cells with the header. There is no
  encoder to build and no scan.
- **Caps.** 4 sessions per peer and 16 in total. A live snapshot costs 184 KB
  (the id map is not part of it),
  so 16 sessions hold about 3 MB. Beyond any cap R replies `BUSY` and remembers
  the requester for a `StateNoticeV1`. A session expires after 30 s idle
  (memory bound, never evidence).
- **Late requests.** R answers every request it receives, however late. J
  decides whether the session is still open.

### 4.5 Joiner session against one peer

1. Send `OpenV1` (both scopes in access-controlled stores) with J's live count,
   `hlcProved` (the snapshot timestamp of the last peer J proved containment
   against in this store, from the sidecar; 0 if none) and `above_J`, J's rows
   newer than `hlcProved`. Receive one `HeaderV1` per scope (S_R at t_R). A
   header that arrives after an attempt timed out still counts while the
   session is open.
2. `count == 0`: R's scope is empty; R is contained at once (the genesis-only
   creator case).
3. **Rows R cannot hold.** J's live rows with a timestamp above R's `hlc` are
   not in S_R, so they start in X. Call their number k. J finds them with an
   index range query (M0 P4): `IntegerCompare({key: ['__context','modified'],
compare: Greater, value: hlc})` plus an `Or` of `StringMatch` on the three
   namespace kinds. It was exact for k = 0-10,000. `count()` takes 0.01-0.87 ms
   for any k, so J uses it for the gap estimate and iterates only to build X
   (3.8-5.3 ms at k = 1,000). SQLite builds the needed indexes lazily on the
   first such query (0.6-1.2 s at 204k rows), so J issues one at open, off the
   critical path. No per-row timestamp table is kept. Rows at exactly `hlc` are
   treated as possibly in S_R; the anchor decides. Then the **fast path**: if `count_R == count_J − k` and
   `sha256(LtHash(S_J) − LtHash(X)) == D_R`, R is contained after one round
   trip, about 0.4 kB. The anchor check is exact, so this is a proof, not a
   guess.
4. **Gap estimate.** gapEst = max(|count_R − (count_J − k)| + k,
   above_R + above_J). The first term was measured. The second (change 2 in
   section 11.1, untested) catches an equal-count gap: J lacks some of R's rows and
   holds as many that R lacks. A count difference alone misses it and restarts
   the doubling from the smallest prefix (848 ms, 175 kB and 10 round trips in
   the measured interleaved case, section 6.1). When `hlcProved = 0` the second
   term is off: "above 0" is every row, so it would equal count_R + count_J
   and make every first join look like a huge gap (M0 P5).
5. **Large gap: let Peerbit sync work.** If gapEst > 256 and Peerbit's sync
   has delivered a namespace row since J opened (sync is delivering), or if
   gapEst > 2,800 (M / 1.45), J asks for no cells. J recomputes gapEst on each
   namespace arrival, O(1), and asks for cells once it is at most T = 256.
   This is the fresh-join path: the proof cost 2.1-11.5 kB in total and
   finished 38-62 ms after the last row arrived (simulated WAN, 10k-1M rows).
   Cross-process (M0 P5, 805 rows), peeling at once at gapEst ≤ 2,800 fetched
   1,472 cells (65 kB), while waiting for T = 256 sent 3.0 kB at the same
   latency (913 against 826 ms, n = 10, within noise). If no namespace row
   arrives during a whole request attempt while the gap is above 256, J peels
   at once when gapEst ≤ 2,800 and switches to the recovery list (step 10)
   above that. That attempt bounds a request; it never makes J ready.
6. **Peel.** J asks for the first m = max(64, ⌈1.8 · gapEst⌉ rounded up to 32)
   cells (R may have pushed them already). J copies its own first m cells at
   that moment and subtracts them. Peeling yields R\J hashes (to fetch or
   explain) and J\R hashes (into X). If the peel stalls, J asks for 4 × m
   cells, up to 4,096. The smallest prefix that decoded was 1.65-1.69 × d at
   d = 10-20, and a 32-cell prefix decoded only 57% of the time at d = 20
   (`sota/c4/out/decodeprobe.ndjson`). Peeling took under 0.04 ms at d ≤ 10,
   1.5-2.0 ms at d = 1,000 and 4-5.4 ms at d = 2,700.
7. **Drain and pull.** For every row J's index adds, the change event carries
   `__context.head` (primitives map, A6) and fires after the index write. J
   removes that hash from the R\J set, O(1). J keeps one pull queue for all
   sessions, so a hash is in flight once however many peers name it (with two
   donors in M0 P5 each session pulled the same 256 hashes). One batch of up
   to 256 hashes is in flight per session; J pulls them with the scope log's
   `join(hashes, {timeout})` (`@peerbit/shared-log index.d.ts:1124-1131`). On
   a fresh join the wait of step 5 leaves at most 256 hashes for the peel, so
   pulls rarely duplicate sync (drain-only was 780 ms against 826 ms with
   pulls in M0 P5).
   Before a pull, J drops a hash whose row its index already has, moves an
   explained hash to E (section 4.6), and leaves a hash that `Log.has` but the
   index lacks for its change event (`@peerbit/log log.js:3756`, `3785`;
   `@peerbit/document program.js:1499-1503`). A fetched entry that is not a row
   of this scope is a lie: R put it in its cells. Peerbit's own pushes keep
   arriving in parallel and shrink the set. There is no stall timer.
8. A hash still not indexed after a pull is classified as before:
    - explained (section 4.6, including `ignored-older`, which needs the
      pulled entry): moved to E;
    - trust-pending (its signer is not yet trusted, and the trust scopes are
      not all contained yet): parked; re-classified on the next trust-graph
      change, whenever any peer's `TRUST_V1` scope becomes contained, and
      whenever C changes;
    - otherwise `fetch-failed`. `join` returns `Promise<void>` with no per-hash
      result, so J cannot tell "nobody can serve it" from a timeout, a busy
      donor or the U-34 stall. After the first failure J opens one fresh
      session with R, because R may have retired the row (case 15), or the
      hash may be a false hint. If the fresh session still names the hash, R
      stays `reconciling` and the pull is retried on R's next sign of life (any
      message, a `replication:change`), on any index change, and when another
      batch finishes. A fetch failure never excludes R. A hash nobody ever
      serves keeps J gated, which is a denial, not a wrong ready; status names
      it (`waiting-fetch`).
9. **Certificate.** When nothing is pending, J checks
   `sha256(LtHash(S_J) − LtHash(X) + LtHash(E)) == D_R`. S_J's lanes are J's
   maintained anchor at that moment (read from the worker at a sequence
   point), and a row that arrived with a timestamp
   above R's `hlc` has already joined X. The check costs one expansion per row
   of X and E, about 2 µs each. On a match R is contained at t_R. J records
   `{peer, openNonce, scope, count, hlc, missingAtStart, pulled}` plus
   `{explained, cells, mode}`.
10. **Mismatch and recovery.** A mismatch means the hint was incomplete or
    wrong: a row arrived after the peel, a peel decoded a false element, or R
    lied. J then (a) peels again against its current cells, with R's cells
    already in hand; (b) if that still fails, opens one fresh session; (c) if
    that also fails, pages R's exact hash list. J checks the list's count and
    `sha256(LtHash(list)) == D_R`. A list that does not match R's own signed
    header is a provable lie (`inconsistent`). Otherwise R\J and J\R come from
    the list, and step 9 runs again. The list costs 32 B per row of R (6.4 MB
    at 200k rows), and it is the only path whose bytes grow with the store.
    The measured design ended in a terminal fallback here instead; that was a
    liveness loss, and this step replaces it (change 3 in section 11.1).
11. `unsubstantiated` needs a provable lie: a hash R's cells or list named
    whose fetched entry is not a row of the scope. A count or set hash R signed
    that its own list contradicts is `inconsistent`.

### 4.6 Explained rows

| Case                                                                                                                                                  | Explained?                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| J's log of that scope holds an entry whose `meta.next` includes this exact head: a CUT, or a later put of the document                                | Yes, `superseded`. R lists a row J has already seen replaced or deleted                                                                              |
| The entry is in J's log but not indexed, and J's indexed row for the same document id wins under Documents' newest-wins rule (`program.js:3824-3830`) | Yes, `ignored-older` (added after M0 P2(b)). J holds a newer row for that id, typically a re-put whose earlier CUT J rejected                        |
| `canPerform` rejected the entry for structure (bad fields, sealed name)                                                                               | Yes, `rejected-structure`                                                                                                                            |
| Rejected because the signer is untrusted, and J contains the trust scope of every peer in C                                                           | Provisionally, `rejected-untrusted`. Re-checked on every trust-graph change and whenever C grows; the head goes back into D if its signer is trusted |
| Rejected because the signer is untrusted, while some trust scope is not yet contained                                                                 | No, `trust-pending` (section 4.5 step 8)                                                                                                             |
| Rejected by the 1 s negative trust cache (`src/index.ts:2111`)                                                                                        | No, `trust-pending`                                                                                                                                  |

**Superseded is a lookup in J's own log, not a map.**
`log.entryIndex.getHasNext(head)` (`@peerbit/log entry-index.d.ts:404`, an
exact match on `meta.next`) returns the entries whose `next` includes the
head. A Documents delete appends a CUT whose `next` is exactly the removed
head (`@peerbit/document program.js:3590-3600`), and the CUT stays in the log:
a fresh joiner's log held all 24 CUTs of 12 retired versions
(`evidence/signed-frontiers/results.txt` §1). So the rule:

- keeps no state, so nothing overflows however long the GC history is (about
  2 CUTs per retired single-chunk version, more for multi-chunk files);
- survives a crash and reopen, because the log is durable (case 26);
- applies only to the exact head. A re-put of the same document id after a
  delete is a new entry with no child in J, so it is never explained. That
  matters because shared-fs re-puts ids on purpose: GC's CUT recovery re-puts
  the document after `del` (`src/index.ts:16232-16243`), Guard D re-puts a
  removed value under its id (`src/index.ts:14199-14203`), and a revoked then
  re-granted trust edge reuses its deterministic id
  (`@peerbit/trusted-network identity-graph.js:193-196`, `controller.js:248-255`).

The lookup runs only for hashes still pending before a pull, at most 256 per
batch. Every explained hash joins E in the certificate (4.5 step 9), so the
set hash still has to match exactly.

**What M0 found (P2, P3).** The lookup finds the CUT whenever J holds it: for
a fresh joiner, after a program reopen, and after a Peerbit restart from disk
with no connections. So no CUT-target index is needed. But J does not always
hold the CUT:

- Documents rejects a CUT whose target is not J's current row head, unless
  that head descends from the target (`@peerbit/document program.js:1810-1850`).
  After a unique re-put of the same id (Guard D, GC CUT recovery) the CUT is
  order-dependent: in real shared-fs a joiner held 6 of 15 such CUTs. R's
  live set then holds the re-put head, so this matters only against a stale R
  that still lists the old head.
- `TrustedNetwork` rejects a delete when J has no local relation
  (`@peerbit/trusted-network controller.js:67-72`, `216-223`). A fresh joiner
  never holds a revocation CUT for a grant it never held.

The case the design left open, J holds the CUT of a later version d but not
d, and R lists the older head h: Documents **indexes h** (3 of 3 runs). The
log's CUT check matches exact `next` only (`@peerbit/log log.js:3878-3888`),
so the deleted document comes back, and J replicated it back to the peer that
deleted it. Containment holds, because h is indexed; the resurrection is an
upstream bug, reported in section 10. The variant: J already holds a newer row
for the same id and lacks the CUT. Then the pulled h is logged as a head but
never indexed (Documents' newest-wins rule), the change event is empty, and
nothing in J's log names h. Without a rule J would stay pending forever. That
is `ignored-older`: after the pull, J reads the entry's document id and
explains h when J's indexed row for that id wins under the same comparison
Documents makes (`program.js:3824-3830`; a test pins the two against each
other). It is the outcome sync reaches on every peer anyway: R replaces h with
J's row by the same rule once it receives it. The K0 fallback "fetch the CUT's
target" is not used: in this variant there is no CUT.

**Rejections.** `canPerform` records `entryHash → {permanent, reason}` only for
hashes in J's in-flight pull batches (at most 256 per session), so the record
is bounded by session size, not by store history. An entry pushed and rejected
before J asked for it is checked again when the pull runs `canPerform` again.
`canPerformEntry` has no delete branch of its own; a delete's key is on
`operation.operation` (`@peerbit/document program.d.ts:52-57`).

### 4.7 Peers and their states

| State                       | Meaning                                                                                                | Blocks ready?                                  | Leaves on                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `asking`                    | an `OpenV1` is in flight (attempts of 5 s, 10 s, 20 s)                                                 | yes                                            | an answer (late ones too), `BUSY`, the last attempt ending                                                           |
| `busy`                      | R replied `BUSY`                                                                                       | yes                                            | R's `StateNoticeV1`, any message from R, another session of J completing (one re-ask), R leaving                     |
| `reconciling`               | waiting for sync, peeling, draining, pulling, recovering, or waiting to retry a failed pull            | yes                                            | the set hash matches, a provable lie                                                                                 |
| `silent`                    | a connected or live peer missed all three attempts                                                     | **yes**                                        | any message from R (a late `HeaderV1` included), a replication announcement or subscribe from R, operator, R leaving |
| `contained`                 | done; records whether R qualified in that session's header                                             | no                                             | final for this open                                                                                                  |
| `left`                      | R unsubscribed or became unreachable after J held its `HeaderV1`                                       | no                                             | R reappears (new session)                                                                                            |
| `left-unanswered`           | R left before J held its `HeaderV1`                                                                    | yes, until its attempt in flight ends (if any) | R reappears (new session); the attempt ends with R still gone (then `gaps`, D4)                                      |
| `unconfirmed`               | visible only through a replication row, no sign of life since J opened, and did not answer one attempt | no (not Required)                              | any sign of life from R (then it is live and asked again with full attempts)                                         |
| `excluded(inconsistent)`    | a recovery list that contradicts R's own signed count or set hash, or an oversize answer               | no                                             | sticky for this open                                                                                                 |
| `excluded(unsubstantiated)` | a provable lie (section 4.5 step 9)                                                                    | no                                             | sticky for this open                                                                                                 |

The rules that matter:

- **Silence never unblocks.** A connected or live peer that has not answered
  keeps J gated, and its answer counts whenever it arrives. This closes the
  event order that defeated all four candidates: a busy live creator times
  out, a stale warm replica answers fast, and J goes ready without the
  creator's rows. The bound is the caller's `awaitWriteReady({timeout})`,
  which names the silent peer. If R is idle and every message it sent J was
  lost (three headers and a notice), nothing triggers again; D14 asks whether
  to add bounded re-asks.
- **Live replicators count.** A peer J sees only through a replication row is
  Required once it shows any sign of life since J opened. This closes the same
  event order when the creator's readiness Subscribe was lost (U-1) but its
  replication traffic still reaches J. Only a row with no sign of life since J
  opened is `unconfirmed`: asked once, and it does not block. That is the
  stale row of a dead peer after an unclean leave. M0 P1 confirmed that such a
  row produces no replication event at a fresh joiner (107 of 107 runs) and
  never reaches its `getReplicators()`, so for a fresh J the rule is
  vacuous. A dead or hung peer can still be relayed to a fresh J as a pubsub
  subscriber (5 of 107 runs); it was unreachable on J's route table, so
  visible-peer discovery filters subscribers by reachability, as
  `visibleFilesystemPeers` does today (`src/index.ts:11170-11192`).
- **Departure (pending D3).** M0 P1: pubsub's own unreachability path never
  runs with the default services, because fanout shares the routes and
  removes the peer first (U-35, deterministic: 0 of 154 observer-runs). A
  dead subscriber is dropped only on peers that hear a PeerUnavailable from
  its fanout parent; the parent itself, and every peer when there was no
  parent, keep it indefinitely (36 of 36 and 82 of 82). So J does not wait
  for `unsubscribe`. It re-reads R's reachability
  (`pubsub.routes.isReachable`, `pubsub.peers`) on libp2p `peer:disconnect`
  and `peer:connect` and on fanout `peer:unreachable`; unreachable means R
  left. That fired 4-24 ms after a `kill -9` or a transport stop in every run.
  A half-open socket keeps R reachable until the TCP inactivity timeout
  (120 s); a hung process with open sockets stays reachable, so it blocks
  until the caller's timeout and status names it "reachable, silent". These
  are private reads until U-37.
- **Leaving before answering.** Pubsub emits `unsubscribe` on a peer session
  reset (`@peerbit/pubsub index.js:3328-3332`, `3392`), so a reconnect flap
  looks like a departure. A peer that leaves before J
  holds its `HeaderV1` is `left-unanswered` and keeps blocking until its
  attempt in flight ends. If it comes back, it gets a new session. If it stays
  away, J records `gaps: {peer, missing: "unknown"}` and status shows it (D4).
  So a timer can end a block only for a peer already reported gone.
- **Departure after answering.** If R leaves while J still lacks rows only R
  listed, J keeps trying to pull them from any peer. If nobody can serve them,
  J records `gaps: {peer, missing}` in the proof and status, and R stops
  blocking (D4).
- **Gated peers are constraints.** Their rows are real, so J must hold them.
  They never qualify in a session where they were gated. When such a peer
  becomes ready it sends `StateNoticeV1`, and J opens a fresh session with it;
  only that session's header can qualify it. So two fresh joiners never
  certify each other's partial views.
- **Required is never frozen.** A peer that becomes visible before the
  decision must be contained or accounted for. A join storm delays readiness
  by about one session per peer; sessions run 4 at a time.

### 4.8 The readiness predicate

```text
ready ⇔ freshFullAddressOpen
      ∧ phase ∈ {off, converged}
      ∧ ∀ R ∈ Required : state(R) ∈ {contained, left, excluded}
      ∧ ∃ R ∈ C : qualified(R) in the HeaderV1 of the session that contained R
      ∧ (accessControlled ⇒ ∀ R ∈ C : trustScope(R) contained,
                                       frozen after its namespace scope)
```

`evaluate()` is a pure function. It runs in a coalesced microtask after any
trigger. It has no timer of its own.

When it holds, `markWriteReady` runs as today (`src/index.ts:10260-10305`):

1. write `{writeReady: true, writeReadySource: "reconciled", bootstrap: null, proof}`
   to `<dir>/shared-fs-bootstrap/<address>.json` and fsync;
2. flip memory, arm Guard D, emit telemetry and `write:ready`, resolve waiters;
3. send `StateNoticeV1` to every peer that had a session or a `BUSY` with J in
   this open. A gated joiner that contained J earlier opens a fresh session
   with J. J's new header says `writeReady`, so that session can qualify J.
   This gives transitive readiness without polling, and never on an earlier
   partial snapshot.

The 100 ms double check goes away; it existed only to confirm the quiet window.
A failed sidecar write retries on the next trigger, as today.

### 4.9 Triggers and bounds

Every re-evaluation comes from one of these public events:

| Event                                                                              | Effect                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| open finished                                                                      | list visible peers, start sessions                                                                                                                     |
| pubsub `subscribe` / `unsubscribe` on the readiness topic                          | add the peer (if reachable) / mark it `left` or `left-unanswered`                                                                                      |
| libp2p `peer:disconnect` / `peer:connect`, fanout `peer:unreachable`               | re-read that peer's route reachability; unreachable → `left` or `left-unanswered`; reachable again → new session (pending D3)                          |
| `replicator:join`, `replication:change`, `replicator:leave` (`index.d.ts:471-473`) | add the peer; a sign of life makes it live (full attempts); leave as above                                                                             |
| any readiness message from R                                                       | advance that session; moves `silent` and `busy` back to `asking`; retries R's failed pulls                                                             |
| index `change` (added rows)                                                        | update J's id map, cells and anchor; drain pending hashes, O(1) per row per live session; recompute the gap estimate; retries failed pulls             |
| trust graph `change` (any, including added-only and empty events)                  | from the current rows: retry `trust-pending`; re-check `rejected-untrusted`; re-check qualification. A revocation may never arrive as a delete (M0 P3) |
| a peer's `TRUST_V1` scope becomes contained, or C changes                          | re-classify `trust-pending` and `rejected-untrusted` heads                                                                                             |
| another session of J completes                                                     | re-ask each `busy` peer once                                                                                                                           |
| bootstrap decision or phase change (the #403 hook)                                 | `evaluate()`                                                                                                                                           |
| attempt timeout                                                                    | next attempt or `silent`; ends `left-unanswered` for a peer still gone                                                                                 |
| pull batch finished                                                                | start the next batch; retry failed pulls                                                                                                               |

Timers that remain. None makes J ready on its own:

| Timer                  | Value                     | Bounds                                                                                                                                                                           |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request attempt        | 5 s, then 10 s, then 20 s | one attempt; then the peer is `silent` and still blocks; ends a `left-unanswered` block; a large gap with no namespace arrival for a whole attempt switches to the recovery list |
| pull `join` timeout    | 10 s                      | one batch; a failed pull waits for a trigger                                                                                                                                     |
| responder session idle | 30 s                      | R's memory                                                                                                                                                                       |

A fake-clock test asserts that no timer is armed while J is gated with nothing
in flight. That pins the owner's no-polling rule.

### 4.10 Durable state

The sidecar keeps its writer, fsync, crash-marker and content-probe rules
(`src/index.ts:3372-3400`, `10779-10985`, `13603-13645`). It gains a `proof`:

```json
{
    "writeReady": true,
    "writeReadySource": "reconciled",
    "proof": {
        "v": 1,
        "scopes": ["namespace-v1", "trust-v1"],
        "contained": [
            {
                "peer": "<hash>",
                "source": "creator",
                "qualified": true,
                "count": 804,
                "hlc": "<u64>",
                "anchor": "<D_R, 32 bytes hex>"
            }
        ],
        "excluded": [{ "peer": "<hash>", "reason": "unsubstantiated" }],
        "gaps": [{ "peer": "<hash>", "missing": "unknown" }]
    }
}
```

- `remote-settled` no longer exists. Sources are `creator`, `reconciled` and
  `operator`.
- The parser's allowlist changes in M1. Today it accepts only `creator` and
  `remote-settled` and treats any other source as malformed, which fails
  closed to an interrupted bootstrap (`src/index.ts:10862-10879`). M1 accepts
  `creator`, `reconciled` and `operator`. `proof` is checked for shape only
  (`v: 1`, bounded arrays); a bad shape is malformed and fails closed the same
  way. The v9.2 address means no old sidecar is ever read.
- At most 32 contained, 32 excluded and 32 gap records are stored.
- The proof is for audit, status and telemetry. Nothing re-reads it to decide
  readiness. The next open reads the highest contained `hlc` as `hlcProved`,
  which only shapes the gap estimate (4.5 step 4).
- The cells, anchor and id map live in a separate file per scope,
  `<dir>/shared-fs-readiness/<address>.<scope>.bin` (184 KB for cells and
  anchor, plus the compact id map, about 8 MB at 200k rows, plus a header
  with the format tag and the live count). It is written at clean close after
  the listener is detached and writes and Guard D re-puts have drained, and
  deleted at open, so a stale file is never trusted after a crash (4.4).
- A crash before the write leaves J gated, and the sessions run again.
  Superseded heads are found in J's log again, so the rerun behaves like the
  first run.

### 4.11 Who is gated, and what else changes in M1

| Open                             | After this change                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Creator                          | ready at once (unchanged); answers `creator`                                                   |
| Warm reopen with a proof         | ready at once (unchanged); answers `warm`; M2 adds a background freshness check (`warm-fresh`) |
| Fresh address-open, full replica | the coordinator above                                                                          |
| Observer or factor < 1           | never writable (unchanged); answers, never qualifies                                           |
| `allowPartialWrites`             | writable this session (unchanged); **never arms Guard D**; maintenance still refused           |
| `assumeComplete()` (new)         | persists source `operator` after an explicit call; for "no qualified donor will ever exist"    |

Also in M1:

- Scheduled GC requires `writeReady` (`gcSchedulerTickInner`, `src/index.ts:13963`).
- Local put ids never count as evidence of anything. This is moot once the
  evidence flag is gone, but the rule is written down for any later per-path
  layer.
- M1 removes only two private reads: `syncronizer.pending`
  (`src/index.ts:10161-10188`) and the readiness fence's use of
  `liveRemoteReplicators` (`hasConnectedRemoteReplicator`,
  `src/index.ts:10190-10191`). `liveRemoteReplicators` itself stays, with its
  private `pubsub.routes` and `getBestRouteHint` reads (`10200-10246`), because
  bootstrap discovery uses it through `visibleFilesystemPeers`
  (`src/index.ts:11172-11194`), which also reads `pubsub.peers` and
  `routes.isReachable` itself (`11184-11185`). Other private `pubsub.peers`
  reads stay as well (`11281`, `11409`, `11754`, and the GC peer gate at
  `14013`). M2 moves bootstrap discovery onto readiness answers and the
  readiness topic's subscribers; the GC gate needs its own decision.
- If the owner takes D3 option A' (after M0 P1), the coordinator adds one
  private read: `pubsub.routes.isReachable` and `pubsub.peers` for departure,
  the same reads `visibleFilesystemPeers` makes (`src/index.ts:11184-11185`),
  re-read only on transport events. It stays until U-37.

### 4.12 Edge cases

| #   | Case                                                                    | Outcome                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plain dial, idle donor                                                  | Ready after transfer plus about 3 round trips                                                                                                                                                       |
| 2   | Donor writes every 1 s                                                  | Ready; the snapshot does not move. p50 0.82-0.93 s measured cross-process (M0 P5)                                                                                                                   |
| 3   | Genesis-only creator                                                    | `count: 0`, contained, qualified. One round trip                                                                                                                                                    |
| 4   | Busy creator plus a stale warm replica                                  | Gated until the creator answers, even after its attempts end (`silent` blocks; the late answer counts); then contained                                                                              |
| 5   | Truncated list, `done` forged early, or a wrong set hash                | The set hash cannot match. A list that contradicts R's own header is `inconsistent`                                                                                                                 |
| 6   | Remote iterate false-empty (U-5/U-6)                                    | Not used. Empty is an explicit `count: 0`                                                                                                                                                           |
| 7   | Stable-id re-put with new bytes                                         | A new entry hash, so it is required                                                                                                                                                                 |
| 8   | Under-reporting peer                                                    | Looks like a lagging donor; other Required peers still bind J                                                                                                                                       |
| 9   | Over-reporting peer (phantom elements)                                  | A hash nobody serves: one fresh session, then R stays `reconciling`, J stays gated (a denial). A hash of the wrong kind: `unsubstantiated`                                                          |
| 10  | Two fresh joiners, donor gone                                           | Contain each other, neither qualifies, both gated                                                                                                                                                   |
| 11  | Two fresh joiners, donor present                                        | First to finish becomes ready and notifies; the other opens a fresh session with it, which can qualify it                                                                                           |
| 12  | Donor leaves after answering, J contained it                            | Still ready                                                                                                                                                                                         |
| 13  | Donor leaves mid-pull, nobody else has its rows                         | `gaps` recorded, R stops blocking (D4)                                                                                                                                                              |
| 14  | Dead peer still in `getReplicators()` after an unclean leave            | No sign of life since open: asked once, `unconfirmed` (a fresh J never sees the row, M0 P1). Subscriber: pubsub may never drop it; it leaves when unreachable on the route table (pending D3)       |
| 15  | Donor retires a row between snapshot and pull                           | One fresh session; the new snapshot lacks it                                                                                                                                                        |
| 16  | J holds the CUT of a head R still lists                                 | `superseded`; not pulled. J may not hold it after a re-put of the same id (M0 P2(a)); then case 41                                                                                                  |
| 17  | Writer revoked during the join                                          | Its rows are provisionally `rejected-untrusted` once every trust scope is contained                                                                                                                 |
| 18  | Trust graph lagging                                                     | `trust-pending`; gated until the edge arrives (correct)                                                                                                                                             |
| 19  | Only partial replicas or observers visible                              | Gated                                                                                                                                                                                               |
| 20  | Late donor pushes (`@peerbit/shared-log index.js:517-538`, `7608-7610`) | Irrelevant; J compares against the snapshot and pulls                                                                                                                                               |
| 21  | 100k files, ten differences                                             | 2 round trips, 1.9 kB, about 0.13 s on a 60 ms link; R freezes in under 1.1 ms by copying 184 KB (simulated)                                                                                        |
| 22  | 20 joiners against one donor                                            | `BUSY` beyond the caps; directed notices and completed sessions re-ask; bounded                                                                                                                     |
| 23  | Lost Subscribe and no other traffic; only the genesis creator visible   | Wrong ready possible (non-guarantee)                                                                                                                                                                |
| 24  | U-34 post-heal 10 s handshake stall                                     | Latency only; a late answer counts and a failed pull is retried, never excluded                                                                                                                     |
| 25  | Clock skew                                                              | No effect on soundness; entry timestamps only shape the hint (case 40)                                                                                                                              |
| 26  | Crash before the proof is persisted                                     | Gated again, sessions rerun; superseded heads are found in J's log again                                                                                                                            |
| 27  | Long GC history (20k CUTs)                                              | No readiness state grows with it; `superseded` is a log lookup and rejections are bounded by in-flight batches                                                                                      |
| 28  | Peer on another format                                                  | Different address; not visible                                                                                                                                                                      |
| 29  | Collision or false decode in the cells                                  | A wrong hint. The set hash does not match; re-peel, a fresh session, then the exact list. A delay, never a wrong ready                                                                              |
| 30  | `allowPartialWrites` session                                            | No gating; coordinator may run for telemetry; Guard D stays disarmed                                                                                                                                |
| 31  | Busy creator whose readiness Subscribe was lost (U-1)                   | Live through its replication traffic; blocks like case 4                                                                                                                                            |
| 32  | Unanswered peer's connection resets and redials                         | `left-unanswered` until its attempt ends; a new session when it is back                                                                                                                             |
| 33  | GC CUT recovery, Guard D resurrection, or trust re-grant during a join  | The re-put head is a new entry with no child in J: required and pulled                                                                                                                              |
| 34  | Trust grant after J's trust snapshot of R                               | Impossible within one session (trust frozen after namespace); across peers, `rejected-untrusted` is re-checked as C grows                                                                           |
| 35  | Entry committed to J's log, index write not done yet                    | Stays pending until its index change event                                                                                                                                                          |
| 36  | Notice from a peer J contained while that peer was gated                | Starts a fresh session; qualifies only through that session's header                                                                                                                                |
| 37  | Equal counts, J lacks 1,000 of R's rows and holds 1,000 R lacks         | Measured: 848 ms, 175 kB, 10 round trips, because the count gap is 0. With `hlcProved` in OPEN (4.5 step 4) the estimate sees the gap: about 1 round plus the pull, 115-168 kB (estimate, untested) |
| 38  | Rejoin with more than about 2,800 rows missing                          | No cells until Peerbit sync shrinks the gap below 256; the recovery list only if no row arrives for a whole attempt                                                                                 |
| 39  | Crash while open                                                        | No persisted cells file (deleted at open), so the next open rebuilds by one scan (2.0-4.0 s at 204k rows in the product, M0 P4)                                                                     |
| 40  | Peer clocks skewed                                                      | Latency only: a wrong `hlc` puts the wrong rows into X, so the set hash does not match and recovery runs. Soundness never uses a clock                                                              |
| 41  | J holds a newer row for an id (a re-put); a stale R lists an older head | J pulls it; Documents logs it but never indexes it. `ignored-older`, explained (M0 P2(b))                                                                                                           |
| 42  | J holds the CUT of version d, not d; R lists the older head h           | Documents indexes h, so R is contained; the deleted document is resurrected (upstream bug, section 10)                                                                                              |
| 43  | Stale R pushes a revoked trust grant to a fresh J                       | J indexes and trusts it until a CUT holder re-offers the CUT (about 1 s while connected, M0 P3); J can be ready in that window. Revocation enforcement is not promised                              |
| 44  | Visible peer hung, sockets open; live replicas also visible             | Stays Required (reachable, silent); gated until the caller's timeout. A fresh J may also take about 60 s to see the live replicas (M0 P1)                                                           |
| 45  | Concurrent same-id writes dispatch change events out of order           | The tap's replace verify re-reads the indexed head; the shadow check stays equal (M0 P4)                                                                                                            |

## 5. Trust and adversarial analysis

| Actor                   | Who                                                       | Can forge rows? | What it can do to readiness                                                     | Defence                                                                                                      |
| ----------------------- | --------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Trusted writer          | keys in the rooted trust graph (`src/index.ts:4255-4268`) | it is trusted   | write rows only some peers have                                                 | containment of every Required peer; frontier layer later (M4)                                                |
| Writer in open mode     | anyone (`src/index.ts:4227-4229`)                         | n/a             | same                                                                            | same; no writer set exists                                                                                   |
| Answering peer          | anyone holding the address; self-announced                | no              | under-report (looks like lagging), over-report, stall, claim to be qualified    | contain everyone; provable lies exclude; silence blocks; late answers count; trusted identity when ACL is on |
| Relay                   | anyone on the path                                        | no              | drop, delay                                                                     | signed messages, count and set-hash checks; latency only                                                     |
| Sybil peers (open mode) | many self-announced peers                                 | no              | each must be contained; can slow J; cannot make J ready without a qualified one | in open mode a Sybil can claim `qualified`; documented (D7)                                                  |

Specific attacks:

- **Truncation and forged answers.** J becomes contained only when its own
  rows, minus X, plus E, hash to R's signed D_R. A shortened, reordered or
  invented answer cannot pass that check without an LtHash32 collision. A
  recovery list that does not hash to R's own D_R is a provable lie.
- **Lying or colliding cells.** Cells are a hint. A false hint, from a
  collision, a lying R or a bug, makes J pull or skip the wrong rows, so the
  set hash does not match and J recovers (4.5 step 10). That is a delay, never
  a wrong ready. In the benchmark an injected collision gave 0 false readies
  in this design and 20 of 20 in every design that trusted 64-bit ids
  (`sota/c1/out/adv.ndjson.gz`, `sota/skeptic/adv.ndjson`).
- **Phantom elements.** A hash R's cells or list name that nobody serves
  cannot be told apart from a slow honest donor (`join` reports no per-hash
  result), so it keeps J gated instead of excluding R. A fetched entry that is
  not a row of the scope makes R `unsubstantiated`. R cannot make J pull junk:
  pulled entries pass the normal `canPerform` checks.
- **Grinding collisions.** There is no salt to learn. To hide a row, an
  attacker needs two different row sets with the same LtHash32. The best
  published attack on LtHash (Ding, Gong, Jiang, Tang 2026, section 11.1)
  breaks the 16-bit parameters in about 2^81 hash queries; for 32-bit lanes
  the same method extrapolates to about 2^160 (an estimate from the survey,
  not re-verified). The cells' 64-bit checksum can be ground in about 2^32
  trials, but that only produces a false hint. The expansion is AES-256-CTR
  keyed by the 32-byte entry hash; this is not a published LtHash parameter
  set, so D17 offers ChaCha20 as the conservative choice.
- **Replay.** Messages carry `sessionId`, the scope, the scope's log id and
  `openNonce`. A foreign or stale session id is ignored. Notices carry
  `openNonce` and never qualify anyone.
- **Lying about qualification.** In access-controlled stores, a qualified
  donor's identity must be in J's trusted set, checked after the trust scope
  is contained. In open mode a peer can claim `writeReady`; it still has to be
  contained, and every other Required peer still binds J.
- **Stalling.** A Required peer that never answers, or that lists heads nobody
  serves, keeps J gated. That is a denial of write readiness, not a wrong
  ready. The bound is the caller's timeout. The way out is the operator escape,
  or the peer leaving.
- **Revoked writers.** Their rows are explained only after J contains every
  peer's trust scope, and only provisionally. J never claims to enforce
  revocation. M0 P3 made one gap concrete: a fresh J never receives the
  revocation CUT of a grant it never held, so a stale peer that pushes the
  revoked grant makes J trust the writer again until a CUT holder re-offers
  the CUT (about 1 s while connected). J can become ready inside that window.
- **What stays open.** A writer whose rows sit only on peers J cannot see. A
  frontier layer (M4) narrows this for trusted writers, if frontiers spread
  wider than the data, for example through always-on witnesses.

## 6. Cost and latency budget

### 6.1 Microbenchmarks of the proof mechanism (2026-10-05)

These are microbenchmarks, not product measurements. One shared harness
(`sota/harness/`) ran every candidate as real code inside a discrete-event
simulation: the candidate's hooks run and are timed, the links are modelled.

- **Machine:** Apple M3 Pro, 12 cores, 36 GB, macOS (Darwin 25.6), Node
  24.13.1. The machine was shared. The load average is given per table; CPU
  columns are inflated under load, bytes and round trips are not.
- **Link:** WAN profile, 60 ms RTT and 50 Mbit/s. Bytes are framed: payload
  plus 160 B per message.
- **Sync:** Peerbit's own sync is modelled as one R→J channel at λ rows per
  second, shared with pulls. W2 has no background sync; missing rows arrive
  only by pull.
- **Workloads:** W1 fresh join (J empty, R holds N rows); W2 rejoin (J lacks d
  of R's rows, holds x rows R lacks, explains e rows); W3 continuous writer (R
  writes 1 or 100 rows/s during the session, 10% of them CUTs).
- **Limits:** one visible peer; no libp2p; the simulation cannot model R
  streaming cells until J says stop, which biases against the rateless
  designs.

**Table A. The chosen mechanism** (`A32.h32.stream.C32.T256`: full-hash cells,
M = 4,096, LtHash32 with BLAKE3, cells pushed with the header, W1 fetch
threshold 256). Median of 3 repetitions, every repetition ready. Load average
82-101 at 10k, 36-92 at 100k, 10-24 at 1M. Source:
`sota/c4/out/table-arms-wan.md`, `sim-c4-arms.ndjson.gz`.

| Workload (WAN)                          | 10k                     | 100k                     | 1M                        |
| --------------------------------------- | ----------------------- | ------------------------ | ------------------------- |
| W1 λ = 5k/s: lag after last row, bytes  | 60 ms, 2.1 kB, 1 RTT    | 38 ms, 11.5 kB, 1 RTT    | 50 ms, 6.2 kB, 1 RTT      |
| W1 λ = 50k/s: lag after last row, bytes | 62 ms, 2.1 kB           | 212 ms, 11.5 kB          | 62 ms, 6.2 kB             |
| W2 d = 0                                | 60 ms, 388 B, 1 RTT     | 64 ms, 388 B, 1 RTT      | 64 ms, 388 B, 1 RTT       |
| W2 d = 0, x = 10                        | 61 ms, 1.9 kB, 1 RTT    | 66 ms, 1.9 kB, 1 RTT     | 81 ms, 1.9 kB, 1 RTT      |
| W2 d = 10                               | 124 ms, 1.9 kB, 2 RTT   | 126 ms, 1.9 kB, 2 RTT    | 131 ms, 1.9 kB, 2 RTT     |
| W2 d = 10, x = 10, e = 1                | 184 ms, 3.6 kB, 3 RTT   | 191 ms, 3.6 kB, 3 RTT    | 127 ms, 1.9 kB, 2 RTT     |
| W2 d = 1,000                            | 416 ms, 86.1 kB, 3 RTT  | 426 ms, 87.5 kB, 3 RTT   | 429 ms, 88.1 kB, 3 RTT    |
| W3 1 row/s over W2 d = 1,000 (lag)      | 419 ms (17 ms), 86.1 kB | 529 ms (78 ms), 87.5 kB  | 429 ms (8 ms), 88.1 kB    |
| W3 100 rows/s over W1 λ = 5k (lag)      | 2.06 s (3.9 ms), 2.3 kB | 20.0 s (7.9 ms), 11.7 kB | 200.1 s (15.8 ms), 6.4 kB |
| Donor CPU per session (medians)         | 0.07-1.2 ms             | 0.44-4.9 ms              | 0.37-1.4 ms               |
| R memory (cells + anchor)               | 184 KB                  | 184 KB                   | 184 KB                    |
| J peak memory (analytic)                | 0.5 MB                  | 1.5 MB                   | 9.9 MB                    |

"Lag" is the time from the last needed row reaching J to the proof
completing. In W1 the transfer itself takes N / λ, which no proof can beat.
Every W3 run finished on R's snapshot, not on equality. All 1,728 sessions of
the arm comparison and all 624 of the main run were ready, with 0 false
readies.

**Table B. Against today's draft** (the list arm of draft PR #406: salted
`u64` ids, 8 B per row). WAN, medians. Draft: 5 repetitions at 10k-100k, 3 at
1M, load 12-154 (median 19). Source: `sota/c1/out/summary-tables.md`.

| Workload (WAN)     | Draft, 100k           | Chosen, 100k           | Draft, 1M             | Chosen, 1M             |
| ------------------ | --------------------- | ---------------------- | --------------------- | ---------------------- |
| W1 λ = 5k/s, bytes | 2.04 MB               | 11.5 kB                | 20.3 MB               | 6.2 kB                 |
| W1 λ = 5k/s, lag   | 0.08 ms               | 38 ms                  | 0.23 ms               | 50 ms                  |
| W2 d = 0           | 193 ms, 803 kB, 1 RTT | 64 ms, 388 B, 1 RTT    | 1.48 s, 8.0 MB, 1 RTT | 64 ms, 388 B, 1 RTT    |
| W2 d = 10          | 317 ms, 804 kB, 3 RTT | 126 ms, 1.9 kB, 2 RTT  | 1.68 s, 8.0 MB, 3 RTT | 131 ms, 1.9 kB, 2 RTT  |
| W2 d = 1,000       | 891 ms, 852 kB, 9 RTT | 426 ms, 87.5 kB, 3 RTT | 2.15 s, 8.1 MB, 9 RTT | 429 ms, 88.1 kB, 3 RTT |
| Injected collision | 20 of 20 false ready  | 0 false ready          | same                  | same                   |

The draft finishes a fresh join about 40-60 ms sooner, because it streams the
list while rows arrive. It pays for that with 2-20 MB of proof bytes. The
chosen mechanism waits until the gap is small and then needs one round trip.

**Table C. Writer hot path** (cost every peer pays on every row change). The
skeptic's sweep: 100,000 operations per run, 3 runs per size, load 3.0-17.7.
Source: `sota/skeptic/upkeep.ndjson`.

| Structure                                   | 200k rows              | 1M rows                | Worst 1%-chunk average |
| ------------------------------------------- | ---------------------- | ---------------------- | ---------------------- |
| Cells over full hashes, no anchor           | 0.28-0.41 µs           | 0.28-0.30 µs           | 0.6-1.6 µs             |
| Cells + LtHash32 with BLAKE3 (as simulated) | 5.13-5.50 µs           | 5.24-5.53 µs           | 10-28 µs               |
| Draft list arm (salted `u64` set)           | 0.54-0.62 µs           | 0.59-0.73 µs           | 1.2-2.4 µs             |
| Range-based tree, without / with an anchor  | 0.34-0.45 / 5.6-5.8 µs | 0.37-0.41 / 5.8-9.1 µs | up to 62 µs            |
| Frontier (version vector with exceptions)   | 0.06-0.07 µs           | 0.06-0.07 µs           | 0.3-1.0 µs             |

The anchor dominates, and almost all of it is the expansion. A second
benchmark measured the expansion alone (LtHash32 including the lane add; 5
repetitions of 100k elements; load 7.3-7.4; `sota/decision/xof-256.ndjson`,
`xof-ds.ndjson` at load 6.7):

| Expansion                                                  | µs per element | Worst 1%-chunk |
| ---------------------------------------------------------- | -------------- | -------------- |
| AES-256-CTR keyed directly by the entry hash, IV as domain | **2.10**       | 8.0 µs         |
| AES-128-CTR, key from sha256 (rejected: 128-bit key)       | 2.66           | 8.6 µs         |
| ChaCha20 keyed by the entry hash                           | 3.21           | 9.6 µs         |
| AES-256-CTR with a separate sha256 key derivation          | 3.24           | 8.4 µs         |
| BLAKE3 XOF (wasm, `hash-wasm`)                             | 4.94           | 9.7 µs         |
| LtHash16 with AES-256-CTR                                  | 2.34           | 7.8 µs         |

So the chosen per-write cost is about 0.25 µs for the cells plus 2.10 µs for
the anchor: **about 2.4 µs per row change. This is an estimate, a sum of
measured parts, not measured end to end.** LtHash16 is not cheaper here,
because the cipher's fixed setup dominates, so we keep the 32-bit lanes and
their margin.

**Measured in the product (M0 P4, supersedes the estimate).** Inside
shared-fs's real change tap the cost per row change was 2.5-6 times the
estimate: p50 5.5-15 µs for an add and 9.5-35 µs for a replace at 50k-200k
rows, p90 of adds 15-34 µs at 200k. The missing parts were decoding the head
string (2.0-2.6 µs), event overhead (about 1 µs), a replace costing two
updates, and the anchor slowing with heap size (2.6-7.6 µs in the product
against 2.10 µs in isolation). K2's 20 µs fails inline at 200k rows. With the
anchor in a worker the main thread pays 1.8-2.6 µs p50 per add and 3.2-5.6 µs
per replace (p99 at most 14 µs), which is what M1 ships (section 4.4).

**Table D. Other costs** (measured unless marked).

| Item                                         | Value                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J cost per arriving row (cells + anchor)     | 5.0-5.2 µs median, 16-24 µs p99 (BLAKE3; 100k rows, 3 runs, load 6.6-8.1); about 2.4 µs with AES-256-CTR (estimate; M0 P4 measured 5.5-15 µs p50 inline in the product, 1.8-2.6 µs on the main thread with the anchor in a worker) |
| Snapshot freeze on R                         | 0.04-1.1 ms (medians, simulated, load 10-100); 5-190 µs on a quieter run (`sota/setrecon/`)                                                                                                                                        |
| Peel on J                                    | under 0.04 ms at d ≤ 10; 1.5-2.0 ms at d = 1,000; 4-5.4 ms at d = 2,700 (1,000 trials each, load 124-139)                                                                                                                          |
| Cells needed to decode                       | 1.65-1.69 × d at d = 10-20, 1.37-1.38 × d at d ≥ 1,000; a 32-cell prefix decodes 99% at d = 10 and 57% at d = 20                                                                                                                   |
| Restart                                      | restore 16-17 ms (128-bit-id arm) or 0.4-0.5 ms (full-hash arm) at 200k rows, against a rebuild of 1.08-1.30 s (3 runs, load 6.6-8.2)                                                                                              |
| Interleaved gap, equal counts, d = x = 1,000 | 848-867 ms, 175 kB, 10 RTT (2 runs, load 4.1-5.9); change 2 (section 11.1) should make it about 1 round plus the pull, 115-168 kB (estimate, untested)                                                                             |

### 6.2 Measured: the end-to-end prototype

In-process prototype of the session flow, in-process calls instead of RPC,
round trips counted (`evidence/upstream-sync/reconcile-run2.out`). It used the
earlier list mode, not the mechanism of 6.1; it measures the coordinator, the
drain and the pulls. A real remote count query round trip measured 6-14 ms
(primitives map B5). "Today" is the current `awaitWriteReady` in the same run.

| Case                              | J open | Contained at | Today             | Mode  | Missing at start | Pulled | Round trips |
| --------------------------------- | ------ | ------------ | ----------------- | ----- | ---------------- | ------ | ----------- |
| 1 file                            | 0.28 s | **0.31 s**   | 5.60 s            | list  | 3                | 3      | 3           |
| 400 files, pull                   | 0.16 s | **0.99 s**   | 5.96 s            | list  | 804              | 512    | 3           |
| 400 files, wait only              | 0.19 s | **0.95 s**   | 6.05 s            | list  | 804              | 0      | 3           |
| 3,000 files, pull                 | 3.0 s  | **7.9 s**    | 12.9 s            | list  | 6,030            | 512    | 4           |
| 3,000 files, wait only            | 3.3 s  | **9.7 s**    | 14.9 s            | list  | 6,030            | 0      | 4           |
| 200 files, donor writes every 1 s | –      | **0.66 s**   | not ready at 25 s | list  | 404              | 404    | 3           |
| second session right after        | –      | +1-120 ms    | –                 | RIBLT | 0                | 0      | 2           |

Other measured inputs: plain dial cross-process 5.34 s today with
prerequisites at 0.23 s (n=6, `quiet-window/results.ndjson`); a 6k-file open
takes 13.6-42 s and the whole store lands at 73-99 s
(`evidence/semantic-safety/results.ndjson`).

The prototype resolved through an in-memory map and its joiner held no rows
(`joinerRows: 0` in every first session). Its session flow carries over; its
list mode does not. M0 P5 re-measured end to end with the mechanism of 6.1,
cross-process over one-way RPC; section "M0 results" has the table (1 file
p50 0.28-0.36 s, 400 files p50 0.93-0.96 s, donor writing every 1 s p50
0.82-0.93 s, n = 20 per batch).

### 6.3 Cost

| Item                   | Value                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per row change, always | one id-map update, one cell walk and one anchor update per scope, on every peer: main thread p50 1.8-2.6 µs per add, 3.2-5.6 µs per replace, anchor in a worker (M0 P4; 5.5-35 µs inline)                                                              |
| Seed                   | restore at open: cells and anchor 0.08-0.78 ms, id map 57-131 ms (text) at 204k rows; after a crash, one projected scan plus build, 2.0-4.0 s at 204k rows (M0 P4)                                                                                     |
| Donor snapshot         | copy 184 KB; worker round trip p50 52-167 µs, p99 0.39-6.8 ms (M0 P4); shared by every session at the same epoch                                                                                                                                       |
| Donor CPU per session  | 0.07-4.9 ms (simulated medians, any N, under load); no encoder, no scan, no sort                                                                                                                                                                       |
| Memory per peer        | 184 KB per scope at any N, plus the compact id map (12.7 MB at 200k rows, 57 MB at 1M, M0 P4), plus 184 KB per live snapshot (16 sessions: about 3 MB)                                                                                                 |
| Joiner memory          | peak 1.5 MB at 100k rows and 9.9 MB at 1M (analytic, simulated)                                                                                                                                                                                        |
| Wire, nothing missing  | about 0.4 kB, 1 round trip                                                                                                                                                                                                                             |
| Wire, d rows differ    | about 1.4-1.7 cells × 44 B per difference, plus framing; 1.9 kB at d = 10, 86-88 kB at d = 1,000; pulls are entry transfer and not counted                                                                                                             |
| Wire, fresh join       | 2.1-11.5 kB in total at 10k-1M rows; Peerbit sync moves the rows                                                                                                                                                                                       |
| Wire, recovery only    | 32 B per donor row (6.4 MB at 200k rows)                                                                                                                                                                                                               |
| Storage                | sidecar proof, at most 96 peer records; one file per scope (184 KB plus the id map, about 8 MB at 200k rows), written at clean close; no index column; SQLite adds lazy indexes on `__context.modified` for the rows-above query (upkeep not measured) |
| Code (estimate)        | +1,000-1,250 product lines (the cells, anchor and peel are about 150-200 of them), +1,150 test lines, about −300 lines (tracker, evidence capture, idle read)                                                                                          |
| Format                 | one salt bump and one program field                                                                                                                                                                                                                    |

### 6.4 Expected latency after M1 (cross-process; M0 P5 measured where marked)

| Case                                    | Today                          | M1                                                                                      | M2                                                                              |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Plain dial, small store                 | 5.45-5.49 s p50 measured       | p50 0.28-0.36 s, p95 0.43-0.53 s (P5 prototype, measured)                               | same                                                                            |
| Plain dial, 400 files (805 rows)        | 6.07-6.11 s p50 measured       | p50 0.93-0.96 s, p95 1.05-1.09 s (P5, measured; bound by row transfer)                  | same                                                                            |
| Two visible donors, 400 files           | 6.16-6.49 s p50 measured       | p50 1.06-1.38 s, p95 1.17-2.58 s (P5, measured)                                         | same                                                                            |
| Warm rejoin, nothing missing            | ready at open (318-352 ms p50) | ready at open, unchanged                                                                | proof session: 1 round trip, 148 B in, 68 B out, p50 0.38-0.44 s (P5, measured) |
| Both peers `bootstrap()`, genesis donor | about 5.7 s measured           | about 5.3-5.7 s (discovery deadline dominates)                                          | under 1 s                                                                       |
| Donor writing every 1 s                 | never (0 of 20 within 20 s)    | p50 0.82-0.93 s, p95 1.13-1.81 s (P5, measured)                                         | same                                                                            |
| 3k-file cold join                       | 12.9-14.9 s in-process         | transfer plus about one round trip                                                      | same                                                                            |
| 200k-row cold join                      | transfer + 5 s, may be partial | transfer plus about 40-210 ms and under 12 kB of proof (simulated at 100k-1M)           | same                                                                            |
| Rejoin after a partition, small diff    | transfer + 5 s                 | 1-2 round trips per peer plus the pull; under 2 kB at d = 10; no scan on either side    | same                                                                            |
| Rejoin with 1,000 rows missing          | transfer + 5 s                 | 3 round trips including the pull, about 88 kB, about 0.43 s on a 60 ms link (simulated) | same                                                                            |
| Unverified bootstrap posture            | at least 10 min                | at least 10 min                                                                         | ends on proof                                                                   |

## 7. API, telemetry and mount behaviour

| Surface             | Change                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrapStatus()` | `writeReadinessSource`: `creator` \| `reconciled` \| `operator`. New `readiness: {state, required, contained[], excluded[], silent[], inFlight[], fetchPending[], gaps[]}`. `msSinceLastArrival` is removed.                                                                                                                     |
| `readiness.state`   | `no-peer`, `no-qualified-donor`, `reconciling`, `waiting-silent`, `waiting-fetch`, `waiting-left`, `waiting-trust`, `waiting-phase`, `ready`                                                                                                                                                                                     |
| `awaitWriteReady`   | Same contract (`src/index.ts:12495-12570`). `ETIMEDOUT` carries the `readiness` snapshot, so callers can say why.                                                                                                                                                                                                                |
| `assumeComplete()`  | New. Persists `operator`, arms Guard D, resolves waiters. Refused on observers and partial replicas.                                                                                                                                                                                                                             |
| Open options        | `writeReadiness?: {requestTimeoutMs = 5000, requireFreshOnReopen = false}` (the second is M2). The internal `writeReadinessSettleMs` is removed.                                                                                                                                                                                 |
| Events              | `write:ready` for every source, creator included. New `readiness:progress` (peer state changes). M2: `freshness:change`.                                                                                                                                                                                                         |
| Telemetry           | `readiness-session{peer, scope, mode, count, gapEst, cells, missingAtStart, pulled, explained, recoveries, roundTrips, ms}`, `readiness-peer{peer, state, reason}`, `write-ready{source, contained, excluded, gaps, ms}`, `writers-unheard{count}` (ACL stores: trusted writers with no row seen). Removed: `synchronizer-idle`. |
| Mount backend       | Unchanged: `EAGAIN` for writable opens and namespace mutations while gated (`mount-backend.ts:142-150`, `939-948`).                                                                                                                                                                                                              |
| CLI `mount`         | Waits as today (`--write-ready-timeout-ms`, default 120000). Prints one progress line ("reconciling with 2 peers, 1 contained, 1 silent: <peer>"). On timeout prints the reason. New `--assume-complete`.                                                                                                                        |
| README              | Replace "settled-view heuristic" and "Nothing is lost" with sections 2.2 and 2.3.                                                                                                                                                                                                                                                |

## 8. Test plan

All tests are deterministic and in-process unless marked. Fault injection uses
test-only hooks on the readiness responder (drop, delay, truncate, lie, `BUSY`,
suppress the readiness Subscribe), on block serving, on the index write after
a log commit, and on `canPerform`. A shared helper with a fake clock asserts
that no timer is armed while J is gated with nothing in flight. Every session
in the suite also runs a shadow check: every peer's maintained cells and
anchor equal a fresh build from its index.

**Behaviour**

| #   | Test                                                                                                         | Pass when                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | Plain dial at 1, 400 and 3,000 files                                                                         | ready, and J's index ⊇ the donor's namespace rows                                                          |
| 2   | Genesis-only creator                                                                                         | ready after one answer with `count: 0`                                                                     |
| 3   | Donor writes every 100 ms                                                                                    | ready within 2 s (starvation regression)                                                                   |
| 4   | Donor leaves after J contained it                                                                            | still ready                                                                                                |
| 5   | Two donors with disjoint extra rows                                                                          | ready only after containing both                                                                           |
| 6   | Stable-id re-put with new bytes                                                                              | the new entry is required                                                                                  |
| 7   | Identical populated store without a proof                                                                    | ready after one answer                                                                                     |
| 8   | Two fresh joiners and a donor; the donor leaves before J2 contains it                                        | J2 stays gated until a fresh session with J1 (after J1's notice) completes; a notice alone never qualifies |
| 9   | Crash between containment and the sidecar write; a lagging donor still lists rows J retired before the crash | gated on reopen; those rows are `superseded` (not pulled, not resurrected, donor not excluded); then ready |
| 10  | Bootstrap snapshot path                                                                                      | phase rule and containment both required                                                                   |
| 11  | Scheduled GC on a gated joiner after the first GC delay                                                      | GC does not run                                                                                            |
| 12  | `allowPartialWrites` with a bootstrap fallback                                                               | Guard D stays disarmed                                                                                     |
| 13  | **6k-file join (slow lane, n ≥ 3)**                                                                          | never ready while any namespace row of the donor is missing from J's index                                 |
| 14  | `changesetStatus` right after ready, for a turn the donor held at its snapshot                               | complete                                                                                                   |

**Adversarial and failure**

| #   | Test                                                                                                                                                                 | Pass when                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 15  | Busy live creator (answers after 6 s) plus a stale warm replica (answers in 20 ms)                                                                                   | not ready until the creator is contained                                                                       |
| 16  | Same, with the creator's readiness Subscribe suppressed                                                                                                              | not ready until the creator is contained                                                                       |
| 17  | Same, with the creator answering after 40 s (after all attempts)                                                                                                     | ready only after the late answer, without the caller retrying                                                  |
| 18  | Connected subscriber that never answers                                                                                                                              | gated; `ETIMEDOUT` names it as reachable and silent; ready after it becomes unreachable (pending D3)           |
| 19  | Unanswered peer's pubsub session resets and it redials                                                                                                               | stays Required; a new session; not ready without it unless it stays away (then `gaps`)                         |
| 20  | `BUSY` whose notice is lost                                                                                                                                          | re-asked when another session completes or on R's next message                                                 |
| 21  | Dead replicator row with no sign of life since open                                                                                                                  | asked once, `unconfirmed`, does not block                                                                      |
| 22  | Truncated recovery list; forged early `done`; wrong set hash in the header                                                                                           | never ready on that answer; a list that contradicts its own header is `inconsistent`                           |
| 23  | Under-report with a second honest peer                                                                                                                               | gated until the honest peer is contained                                                                       |
| 24  | Under-report as the only peer                                                                                                                                        | ready; the proof names the peer (pins the non-guarantee)                                                       |
| 25  | Over-claim: cells or a list naming a hash whose entry is of the wrong kind                                                                                           | `unsubstantiated`; with no other qualified donor, gated                                                        |
| 26  | Honest donor whose block serving is delayed past two pull timeouts                                                                                                   | never excluded; ready once the blocks are served                                                               |
| 27  | Hash named by R but never served by anyone                                                                                                                           | gated, `waiting-fetch` names the peer; never excluded                                                          |
| 28  | Peel succeeds but the set hash does not match (injected false decode, a lying cell, a hook-forced collision)                                                         | never ready on the hint; re-peel, fresh session, then the list; ready with the correct rows (change 3)         |
| 29  | Equal counts with a symmetric difference of 2k (interleaved), with and without `hlcProved`                                                                           | correct result; with `hlcProved`, one cell round plus the pull (change 2)                                      |
| 30  | Gap of 5,000 rows on rejoin; then the same with sync stalled for a whole attempt                                                                                     | no cells until the gap is below 256; with sync stalled, the recovery list; ready either way                    |
| 31  | Replayed or foreign `sessionId`, wrong log id for the scope, notice with a stale `openNonce`                                                                         | ignored                                                                                                        |
| 32  | Only gated peers; only partial replicas                                                                                                                              | gated; `state: no-qualified-donor`                                                                             |
| 33  | No peer visible; fake clock advanced by hours                                                                                                                        | never ready; a later peer makes it ready by event                                                              |
| 34  | Trust lag: a row whose trust edge arrives later                                                                                                                      | gated until the edge, then ready                                                                               |
| 35  | Revoked writer's rows                                                                                                                                                | explained once all trust scopes are contained; ready                                                           |
| 36  | Grant and write land at R between J's trust and namespace views; a second peer holding the grant joins C after a rejection                                           | trust is frozen after namespace; `rejected-untrusted` is re-checked; ready only with the edge and the rows     |
| 37  | `trust-pending` head whose last trust session completes with an empty D                                                                                              | re-classified without a trust-graph change; no hang                                                            |
| 38  | Cross-process ACL store; the joiner lacks one trust edge                                                                                                             | `TRUST_V1` pulls from `trustGraph.log`; ready with the edge                                                    |
| 39  | Donor lists a head whose CUT J holds                                                                                                                                 | `superseded`; not pulled; no resurrection                                                                      |
| 40  | GC CUT plus recovery re-put during a join                                                                                                                            | the re-put head is required and pulled                                                                         |
| 41  | Guard D resurrection with the stale delete already admitted at J                                                                                                     | the re-put head is required                                                                                    |
| 42  | Revoke then re-grant of a writer during a join                                                                                                                       | the re-grant is required; the writer's rows are held                                                           |
| 43  | Donor with 20k CUTs (slow lane)                                                                                                                                      | a fresh joiner becomes ready; no readiness state grows with the CUT count                                      |
| 44  | Index write delayed after the log commit (hook)                                                                                                                      | not ready until the index has the row                                                                          |
| 45  | Donor departs mid-pull with rows nobody else has                                                                                                                     | `gaps` recorded; behaviour per D4                                                                              |
| 46  | `BUSY` storm: 20 joiners, one donor                                                                                                                                  | all ready; the donor never exceeds its caps                                                                    |
| 47  | `assumeComplete()` with no peers                                                                                                                                     | ready with source `operator`; refused on an observer                                                           |
| 48  | Clean close and reopen; crash and reopen                                                                                                                             | restored cells and anchor equal a fresh build; after a crash no file exists and the peer rebuilds              |
| 49  | Replace (re-put of a document id) on a donor and on a joiner: non-unique, `unique` over a present row, remote fork; plus two peers making concurrent same-id re-puts | the replaced head leaves the id map, cells and anchor (M0 P2(c), P4); shadow check equal on both peers         |
| 50  | Writer at 100 rows/s during a 100k-row join                                                                                                                          | ready on R's snapshot; rows above R's `hlc` go to X; no chase                                                  |
| 51  | Peers with clocks skewed by hours                                                                                                                                    | never a wrong ready; recovery may run (latency only)                                                           |
| 52  | J holds a newer row for an id and lacks the CUT; a stale R lists the older head                                                                                      | `ignored-older`; ready; the older head is not indexed                                                          |
| 53  | Cross-process: a visible subscriber is killed (`kill -9`) before answering, with J as its fanout parent and with no parent                                           | `left-unanswered` within one transport event; then `gaps`; never waits for pubsub (pending D3)                 |
| 54  | Cross-process: a visible subscriber is frozen (`SIGSTOP`)                                                                                                            | gated; `ETIMEDOUT` names it as reachable and silent; no wrong ready                                            |
| 55  | Stale peer pushes a revoked trust grant to a fresh J                                                                                                                 | J may turn ready while trusting the writer; it stops when the CUT is re-offered; pins the stated non-guarantee |
| 56  | Tap rules: removed values and remote arrivals without `kind`; an event value mutated by a later put; events during open                                              | shadow check equal; class-based scoping; attached before ingest                                                |
| 57  | Clean close with late Guard D re-puts in flight                                                                                                                      | the persisted file is written after the drain and equals a fresh build on reopen                               |

**Cross-process** (the `quiet-window` harness): n = 20 for plain dial, both
`bootstrap()`, and donor writing every 1 s. Report p50 and p95.

**Mount** (hosted smokes, #387): a fresh mount returns `EAGAIN` until ready and
then accepts `git clone` with no naming conflicts.

## 9. Milestones and kill points

| Milestone                                      | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Exit                                                                                                                                                                                          | Kill point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** Probes (private copy, about 3 days)     | P1: how long pubsub keeps a subscriber after an unclean leave, and whether a dead peer's stale replication row produces any replication event at a fresh joiner. P2: (a) `log.entryIndex.getHasNext` finds the CUT of a head J never held, in the entries log and the trust log, after a reopen; (b) what Documents indexes when J pulls an older head whose later version's CUT J holds. P3: whether trust revocation always reaches a joiner as a delete (`@peerbit/trusted-network controller.js:248-255`). P2(c): a Documents replace always carries the replaced head in `meta.next[0]`, so the change tap can subtract it. P4: per-change cost of cells plus the AES-256-CTR anchor in the product's change tap, restore and rebuild time, and freeze time at 50k and 200k rows; whether J can find its rows above an `hlc` with an index range query. P5: the prototype over one-way RPC messages, cross-process. P6: whether put paths can carry `meta.data` tags. File U-36.                                                                                                                                                                                                                                                | results recorded under `readiness-design-20261004/m0/` (done 2026-10-05: `m0/RESULTS.md` and section "M0 results")                                                                            | **K0:** if P1 shows dead subscribers linger over 60 s, `silent` still blocks until pubsub's peer-unreachable `unsubscribe` (`@peerbit/pubsub index.js:3334-3351`), never on elapsed attempts; the linger is latency, and U-37 is filed. If P1 shows they are never dropped, D3 goes back to the owner with option B and its wrong ready. If P2(a) fails, keep a CUT-target index (entry hash → CUT) from the change tap and one log scan at open, bounded by the log, not by a cap. If P2(b) shows the older head is logged but never indexed, J also fetches the CUT's target and explains the head when that target descends from it. **Outcome (2026-10-05):** K0 fired on "never dropped", so D3 is back with the owner; the P2(a) and P2(b) fallbacks were not taken, and `ignored-older` was added instead (section "M0 results"). |
| **M1** Proof-based readiness (no upstream)     | Salt `/shared-fs/v9.2` and the RPC field; one-way messages; maintained cells (M = 4,096, full hashes), LtHash32 anchor in a worker thread and a compact id → head map per scope on every peer, with the tap rules of 4.4 (class scoping, replace verify, digests), persisted at clean close after the drain; sessions (anchor fast path, rows above `hlc` by a `__context.modified` range query, gap estimate with `hlcProved`, first flight of `max(64, 1.8·gap)` cells, ×4 on a failed peel, wait for sync to T = 256 while it delivers and above 2,800 always, set-hash certificate, recovery list, one shared pull queue); coordinator; peer states including live and `left-unanswered`, departure by route reachability (per D3); the `superseded` lookup, `ignored-older` and the bounded rejection record; `TRUST_V1` on `trustGraph.log`; `ChangesetManifest` in `NAMESPACE_V1`; directed `StateNoticeV1` as a trigger only; `assumeComplete`; sidecar proof and parser allowlist; telemetry; CLI line. Remove the quiet window, the poll, the double check, the evidence flag, the `syncronizer.pending` read and the fence's route read. Gate scheduled GC on readiness. Guard D never armed by the override. Tests 1-57. | cross-process plain dial p50 ≤ 0.6 s and p95 ≤ 1.5 s (n = 20); continuous writer ≤ 2 s; test 13 green n ≥ 3; suite green 3 times; no timer armed while idle-gated; shadow check never differs | **K1:** p95 > 1.5 s, flakes > 1 in 200, or a soundness hole in review: ship containment as an extra prerequisite of today's tracker (strictly safer than today, no faster) and diagnose before going further. **K2:** if the shadow check ever finds maintained cells or anchor differ from a fresh build, or per-change upkeep on the main thread exceeds 20 µs (p90) at 200k rows, or the anchor worker falls behind without bound, build each snapshot by a scan instead (about 2-4 s CPU at 200k rows in the product, M0 P4) and keep the same wire format. (M0 P4: inline, the anchor already trips this at 200k; hence the worker.) If the AES-256-CTR expansion is rejected in review, use ChaCha20 (3.21 µs, D17).                                                                                                               |
| **M2** Reach                                   | Warm freshness: fetch without joining, explained by superseding entries in J's log; `warm-fresh`; only `warm-fresh` qualifies (D6); opt-in `requireFreshOnReopen`. Bootstrap decision on a complete qualified answer (both `bootstrap()` under 1 s). `unverified` posture ends on proof. Bootstrap discovery moves off the private `pubsub` reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | both-bootstrap p95 < 1 s; freshness at rest ≤ 1 request per peer per minute in a 10-peer soak                                                                                                 | If freshness load is too high, make it on-demand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **M3** Adopt U-36 (when released in a cohort)  | Capability-selected transport behind one `ReconcileTransport` seam; shadow test comparing entry-hash sets; delete the interim session messages and shared-fs's own cells; keep the explain step, the anchor check against U-36's range certificate, and a small provenance attestation RPC; ride the next salt bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | shadow sets equal on all tests; latency not worse than M1                                                                                                                                     | **K3:** if U-36 lacks metadata scoping and whole-log scope makes ready more than 20% slower on a store with large files, keep the interim for namespace scope and use U-36 for trust only. Scoping cannot use `meta.data` as it is: shared-log overwrites it with `MinReplicas` on every append (M0 P6), so U-36 needs its own tag field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **M4** Optional: signed frontiers (ACL stores) | Per-stream (author key, random stream id) frontiers that commit to entry hashes, signed and bound to the store id, ordered by seq; carried in answers and by witnesses; default policy `available`, never `strict`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | closes the stale-donor test when a witness holds the frontier; frontier bytes < 2% of write bytes                                                                                             | if frontier traffic > 5% of write bytes, or `writers-unheard` stays at zero in practice, drop it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **M5** Optional: per-operation readiness       | Owned writes never wait; foreign writes prove their footprint over the same RPC; built only on top of the M1 global proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | first foreign write about 0.2 s after open at 6k files (measured with a stand-in)                                                                                                             | if footprint coverage cannot be made exhaustive by a table-driven test, drop it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

M1 depends on no unreleased upstream work. It uses public surfaces of the
5.4.10 cohort: `@peerbit/rpc` 6.2.4 (`send` with `to`), `node:crypto`
(AES-256-CTR, sha256), `node:worker_threads`, the projected index iterate
and count with `__context.head` and `__context.modified`,
`SharedLog.join(hashes)`, `Log.has`, `log.entryIndex.getHasNext`,
`getReplicators`, replicator and pubsub events, libp2p `peer:disconnect` /
`peer:connect` and fanout `peer:unreachable`, the trust graph's own
`Documents` log, and `getTrusted()`. If D3 goes the recommended way, it also
reads `pubsub.routes.isReachable` and `pubsub.peers` privately, as shared-fs
already does (`src/index.ts:10200-10246`, `11185`), until U-37.

## 10. Upstream asks

The four candidate designs each drafted a different "U-36". They are merged
here.

**U-36: receiver-initiated reconcile with a completion result.** A
`SharedLog.reconcile({peer, scope: {range?, metaDataPrefix?}, fetch, signal})`
that resolves only when every entry R held in scope when it received the
request is in the caller's log or listed as rejected with a typed reason. It
never resolves with a partial result. No answer, R leaving, abort or no
support reject with a typed error. Support is detected within one round trip.
It works for any size, including above `maxRatelessReceiveRangeEntries`
(16,384). It emits `reconcile:complete {peer, sessionId, missing, joined}`.
Folded in: a per-hash result for `join(hashes)` (today it returns
`Promise<void>`, `@peerbit/shared-log index.d.ts:1124-1131`, which is why a
fetch failure can never exclude a peer), and a per-peer receive-progress
event. Optional part (b): scoping by an application tag. M0 P6 found that
`meta.data` is not free for applications: `SharedLog.createLogAppendOptions`
overwrites it with the encoded `MinReplicas` on every append
(`@peerbit/shared-log index.js:10873-10882`), and shared-log decodes it as
`MinReplicas` everywhere (`replication.js:593-606`). So part (b) must add a
separate tag field, or define `meta.data` as `MinReplicas` followed by an
application suffix with a tolerant decoder. Full semantics and
done-when tests: `evidence/design-upstream-sync.md` §3. This closes U-7.

**U-36 mechanism (2026-10-05).** The benchmark (section 11.1) says how U-36
should work inside shared-log, so that sync and readiness share one
reconcile:

- Each segment keeps a universal RIBLT prefix over full 32-byte entry hashes
  and an LtHash32 of its entries. Both are additive, so any segment-aligned
  range is answered by XOR of cells and addition of lanes. No per-session
  encoder, no sort.
- A streamed sender pushes cells until the receiver says stop.
- The decoded R\J set is exactly what sync fetches, so nothing is transferred
  twice.
- The completion signal carries the count and a range certificate D_range
  (sha256 of the range's LtHash lanes).
- shared-fs then drops its own cells and keeps only the explain step and the
  anchor check.

The "upstream" candidate as benchmarked must not ship as is: its cells held
unsalted 64-bit ids, an injected collision gave 20 of 20 false readies, and a
writer can produce a real collision in about 2^32 hash trials (estimate).

**`@peerbit/riblt` fixes (only if U-36 builds on it).** `Encoder::remove_symbol`
is O(n); the incremental sketch is not exported through wasm; a 32-bit PRNG
seed failed 4 of 20 decodes at d = 40k.

**Today's rateless sync engine.** Two findings for the upstream owner, not for
shared-fs to change. The 16,384-row receive cap plus the 30 s TTL makes every
large rejoin fall back to a full hash list (about 53 MB and an estimated
3,240 s stall at 1M rows). The `[start, end)` range query always mis-decodes
R's highest element as R-only.

**U-37 (K0 fired on 2026-10-05): a public peer reachability signal.** A
documented way to learn that a peer is reachable now, and an `unsubscribe`
within a stated bound after an unclean leave. Today the fence and discovery
read `pubsub.routes` privately (`src/index.ts:10200-10246`). M0 P1 adds the
evidence: pubsub's `onPeerUnreachable` never runs when fanout shares the
routes (U-35, deterministic, `@peerbit/pubsub index.js:416`, `3334-3365`;
`@peerbit/stream index.js:1624`, `routes.js:264-295`); the fanout parent
announces PeerUnavailable to others but never applies it locally
(`@peerbit/pubsub index.js:3071-3098`); the receive path ignores it while a direct stream
looks readable (`:3865`); nothing bounds subscriber state; and
`abortConnectionOnPingFailure: false` (`peerbit libp2p.js:81`) leaves
half-open and hung peers connected. Done-when: after `kill -9` every remaining
peer emits `unsubscribe` within a stated bound, and a hung peer is dropped by
a stated liveness policy. To be handed to the upstream owner by the user.

**Other upstream reports from M0 (2026-10-05).** For the upstream owner; no
upstream code was changed.

| Package                    | Finding                                                                                                                                                                                                                   | Evidence                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@peerbit/document` / log  | Pulling an older head h whose later version's CUT the receiver holds resurrects the deleted document, which then replicates back to the deleter. The CUT check covers exact `next` only (`@peerbit/log log.js:3878-3888`) | `evidence/m0/p2p3/docs-run{4,5,6}.lines.txt` |
| `@peerbit/document`        | Change events of concurrent same-id writes can be dispatched in a different order from the index writes (`program.js:3912`), so a consumer that trusts event order diverges                                               | `evidence/m0/p4p6/remote.ndjson`             |
| `@peerbit/document`        | A `unique` put over a present row replaces it with `meta.next = []`, and no replace reports the replaced head as `removed`                                                                                                | `evidence/m0/p2p3/`, `p4p6/remote*.ndjson`   |
| `@peerbit/trusted-network` | A delete with no local relation is rejected rather than kept as a tombstone, so a fresh joiner never learns a revocation and a stale peer can re-introduce the revoked grant                                              | `evidence/m0/p2p3/trust-run{1-4}.lines.txt`  |

**U-38 (for M4 only): the authenticated signer in Documents change context.**
Today the signer is visible only at ingest (`src/index.ts:4230`). Frontiers per
signer need it.

Not asked: `@peerbit/rpc` drops a response that arrives after its request
settled (`controller.js:273-279`, `662`). The design avoids `rpc.request`
instead.

How existing asks change the design when they land:

| Ask           | Effect                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| U-7           | Superseded by U-36. If it lands as a passive event only, use it to skip a session when Peerbit already reports R as reconciled.              |
| U-1           | Fewer invisible peers, so the non-guarantee shrinks. A lost readiness Subscribe already matters less: replication traffic makes a peer live. |
| U-34          | Latency only: the 10 s stall delays an answer or a pull, which still counts or is retried.                                                   |
| U-19          | Not needed; the RPC projects its own answers.                                                                                                |
| U-5/U-6       | Not needed; a missing answer is never read as empty.                                                                                         |
| U-32 residual | Not used; readiness does not depend on persisted receipts.                                                                                   |

## 11. Alternatives considered

Four designs were written against the same maps and reviewed by three
reviewers: rigor and safety, cost and complexity, delivery and dependencies.

| Design                                            | Rigor | Cost | Delivery | Mean | Outcome                        |
| ------------------------------------------------- | ----- | ---- | -------- | ---- | ------------------------------ |
| `upstream-sync`: snapshot containment, then U-36  | 6.5   | 7    | 8        | 7.2  | **base**                       |
| `digest-visible`: incremental digest trie         | 7     | 6.5  | 7        | 6.8  | predicate and features grafted |
| `semantic-safety`: per-operation footprint proofs | 4.5   | 4.5  | 5        | 4.7  | fixes and evidence grafted; M5 |
| `signed-frontiers`: stamped ids and frontiers     | 3.5   | 4    | 4        | 3.8  | idea kept for M4               |

**`upstream-sync` (chosen).** Strengths: the only measured end-to-end
prototype; a true snapshot needs no mixed-time lemma; entry-hash identity
handles re-puts and maps onto Peerbit's own sync; no index column; a clean seam
to U-36. Weaknesses we fixed: it froze Required at the first qualified
containment and excluded silent peers after about 19 s, so a busy creator plus
a stale warm donor could produce a wrong ready (all three reviewers); trust
scope was checked against one peer only; resolve re-scanned per request,
O(n²/1024) at 200k rows; unsalted u64 elements allowed grinding.

**`digest-visible`.** The most precise guarantee text, and the strictest
predicate (never frozen, trust scope of every covered peer). Cheapest steady
check: equal views in one round trip and about 100 B. Not chosen as base: no
end-to-end prototype; a permanent 16-byte index column and an incremental store
that must stay exact; a 1 s stall nudge; an over-budget exclusion that could
drop the only donor during a long sync. Grafted: the predicate, the trust
rule, `StateNoticeV1`, `assumeComplete`, the persisted proof, the bootstrap
decision on answers, and the incremental set (now in M1, in memory only, with
a shadow check instead of an exactness proof).

**`semantic-safety`.** The best analysis of what an early write does, and the
key new evidence: today's window certified 6k-file joiners with 3-4% of rows
missing, and pulling is necessary because sync is not path-aware. Not chosen:
its M1 kept the quiet-window tracker for global readiness, warm proofs, Guard
D and GC, which its own data shows is unsound; it needs correct footprints at
21 entry points; blocking FUSE calls up to 10 s are unverified. Grafted: the
GC gate, Guard D never armed by the override, the 6k regression test (test 13),
and per-operation readiness as optional M5.

**`signed-frontiers`.** The only design aimed at invisible writers. Not
chosen: accounting by (tag, seq) breaks when a store directory is restored
from backup; a fast stale answer could win before a slower live one; its
strict default lets one offline laptop block every joiner; its CUT-accounting
premise is unproven and its fallback uses wall-clock windows as evidence.
Kept: the idea, redesigned for M4 to commit to entry hashes, with `available`
as the default, plus the measured fact that a fresh joiner's log keeps every
earlier CUT, which the `superseded` lookup reads.

**Parts of the first answer we dropped or changed.**

| Earlier idea                                         | Now                                                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Equal fingerprint with each visible peer             | Containment of a snapshot. Equality rarely holds while anyone writes.                                                   |
| Short timer when no peer is visible                  | Rejected. Over an empty set the check is vacuous; warm reopen already works offline.                                    |
| Quorum k of n                                        | Rejected. Writes are local-first, so there is no write quorum to intersect, and replicators are self-announced (Sybil). |
| Rely on conflict-preserving semantics                | Not enough alone: E1 and directory splits are real harm. It stays the floor.                                            |
| Donor-confirmed ids (the 0.54 s prototype)           | Superseded: ids only, truncation-prone answers, partial or gated donors, O(rows) per check.                             |
| Re-anchor the quiet window and stop arrival restarts | Kept only as the K1 fallback, combined with containment.                                                                |

### 11.1 State of the art: the proof mechanism (2026-10-05)

The owner asked for the most performant, state-of-the-art way to prove
containment, with no preference between approaches. Three surveys covered set
reconciliation, authenticated set summaries and causal-history sync
(`sota/survey-*.md`). Six mechanisms then ran on one harness with the same
workloads (section 6.1), and a skeptic re-ran the contested cases
(`sota/skeptic/`).

**Verdict.** For M1, a maintained prefix of rateless IBLT cells over full
entry hashes as the hint, and an LtHash32 set hash as the certificate ("hint,
then verify"). For the end state, the same two structures per segment inside
shared-log (U-36, section 10). The idea is not new on its own. The RIBLT paper
proposes one universal coded sequence per peer, updated incrementally. LtHash
is deployed as a running set hash (Meta's Folly, Solana SIMD-0215, Bluesky
proposal 0016). Combining them, so that a fast probabilistic hint can never
produce a wrong "done", is what this design adds.

**The six measured candidates.** Numbers are from section 6.1 or the
candidates' own runs (WAN, simulated, medians).

| Candidate                                               | Best at                                                                               | Outcome and reason                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 list (the draft's list arm)                          | fresh-join lag (0.1-0.2 ms after the last row)                                        | Rejected. 8 B per row in every session (8 MB at 1M rows even when nothing is missing); J re-hashes its store under each peer's salt (0.7 s per peer at 1M); the `u64` arms gave 20 of 20 false readies on an injected collision. Its anchor arm (d = 0 in 1 RTT) is kept; its cursor works only while R stays up. |
| C2 per-session `@peerbit/riblt`                         | nothing                                                                               | Rejected. O(n log m) on both sides in every session; at 1M rows a 32-symbol header alone costs R about 440 ms; 20 of 20 false readies.                                                                                                                                                                            |
| C3a today's shared-log rateless engine                  | nothing                                                                               | Rejected. 2.6 s to build an encoder at 1M rows; above 16,384 rows it falls back to a full hash list (53 MB at 1M) and the 30 s TTL causes an estimated 3,240 s stall; 20 of 20 false readies.                                                                                                                     |
| C3b maintained prefix inside shared-log (a U-36 sketch) | no per-session build; 0.43-0.71 µs per write                                          | Not shipped as measured: unsalted 64-bit cells gave 20 of 20 false readies. It becomes U-36 with full hashes and a per-segment LtHash.                                                                                                                                                                            |
| **C4 maintained prefix + LtHash anchor**                | every W2 shape in 1-3 RTT and at most 88 kB at any N; W1 under 12 kB; 184 KB per peer | **Chosen for M1**, with five required changes: (1) a first flight of `max(64, 1.8·gap)` cells; (2) the `hlcProved` gap estimate; (3) recovery by the exact list on a set-hash mismatch; (4) wait for sync on gaps above about 2,800; (5) the AES-256-CTR anchor, persisted.                                       |
| C5 range-based (negentropy-style)                       | gaps clustered in time (38 kB at d = 1,000)                                           | Rejected. Scattered gaps of d = 1,000 cost 851-980 kB and every d > 0 takes 4 RTT counting the pull; its sum fingerprints were forged 20 of 20, so it needs the anchor too: about 5.7 µs per write plus a 45 B per row tree.                                                                                      |
| C6 frontier (version vector with exceptions)            | fastest W2 (332 ms, 45 kB, 2 RTT on interleaved gaps); 61 ns per write                | Rejected, the strongest rival. A new row format of about 52 B per row (10 MB per replica at 200k rows, 52 MB at 1M; analytic); its proof grows with GC churn (587 KB at 1M for d = 0, freeze 25-60 ms); three soundness bugs found during its development; shared-fs only, no path to U-36.                       |

The format change C6 needs would have been allowed (no production users). It
lost on bytes and risk, not on policy.

**Surveyed techniques.** "Chosen" means used in the design; "measured" means
benchmarked as one of the candidates above.

| Technique                                  | Source                                                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rateless IBLT                              | L. Yang, Y. Gilad, M. Alizadeh, "Practical Rateless Set Reconciliation", SIGCOMM 2024, https://arxiv.org/abs/2402.02668                                                                                                                                                                                 | **Chosen** as the hint. No difference estimator, about 1.35-1.7 cells per difference, O(d) peel, and a universal prefix that a writer can update in O(log M). |
| Classic IBLT with a strata estimator       | M. T. Goodrich, M. Mitzenmacher, "Invertible Bloom Lookup Tables", Allerton 2011, https://arxiv.org/abs/1101.2245; D. Eppstein, M. T. Goodrich, F. Uyeda, G. Varghese, "What's the Difference? Efficient Set Reconciliation without Prior Context", SIGCOMM 2011, doi:10.1145/2018436.2018462           | Not chosen. Needs an estimator round and one table per size; 3-4 times RIBLT's bytes at small d.                                                              |
| Graphene                                   | A. P. Ozisik, G. Andresen, B. N. Levine, D. Tapp, G. Bissias, S. Katkuri, "Graphene", SIGCOMM 2019, doi:10.1145/3341302.3342082                                                                                                                                                                         | Not chosen. Built for "the receiver holds most of a block"; its Bloom stage cannot prove containment.                                                         |
| PinSketch / Minisketch (Erlay)             | Y. Dodis, R. Ostrovsky, L. Reyzin, A. Smith, "Fuzzy Extractors", Eurocrypt 2004; libminisketch, https://github.com/bitcoin-core/minisketch; G. Naumenko, G. Maxwell, P. Wuille, A. Fedorova, I. Beschastnikh, "Erlay", CCS 2019, doi:10.1145/3319535.3354237                                            | Not chosen. Optimal in bytes, but O(capacity) work per insert, quadratic decode, and no vetted JS or wasm build.                                              |
| CPISync                                    | Y. Minsky, A. Trachtenberg, R. Zippel, "Set reconciliation with nearly optimal communication complexity", IEEE Trans. Inf. Theory 2003, doi:10.1109/TIT.2003.815784                                                                                                                                     | Not chosen. Cubic decode and a known bound on d.                                                                                                              |
| Range-based reconciliation (negentropy)    | A. Meyer, "Range-Based Set Reconciliation", SRDS 2023, https://arxiv.org/abs/2212.13567; negentropy, https://github.com/hoytech/negentropy                                                                                                                                                              | Measured (C5). Second. The right shape for a range-scoped upstream protocol, not for scattered gaps.                                                          |
| Bloom have/need (Automerge sync)           | J. Byers, J. Considine, M. Mitzenmacher, S. Rost, "Informed content delivery across adaptive overlay networks", SIGCOMM 2002; Automerge sync, https://automerge.org/automerge/automerge/sync/index.html                                                                                                 | Not chosen. Bytes grow with n (about 1.8 MB at 1M), and a false positive hides a missing row.                                                                 |
| Newer sketches (not benchmarked)           | T. Keniagin, E. Yaakobi, O. Rottenstreich, "CertainSync", SIGMETRICS 2025, ePrint 2025/623; R. Xu et al., "Toward Optimal Time-Space Tradeoffs for Set Reconciliation", 2026, https://arxiv.org/abs/2609.14442; J. Klausen, R. Pagh, S. Walzer, "Stuffed IBLTs", 2026, https://arxiv.org/abs/2609.17487 | Not chosen. At most about 25% fewer bytes than RIBLT, whose bytes are already small; no JS ports. Taken from the survey, not re-verified.                     |
| LtHash                                     | M. Bellare, D. Micciancio, "A New Paradigm for Collision-free Hashing: Incrementality at Reduced Cost", Eurocrypt 1997, https://eprint.iacr.org/1997/001; K. Lewi, W. Kim, I. Maykov, S. Weis, "Securing Update Propagation with Homomorphic Hashing", 2019, https://eprint.iacr.org/2019/227           | **Chosen** as the anchor. A function of the set only, additive, 4 KB, constant cost per update, subtraction for removals.                                     |
| LtHash cryptanalysis                       | R. Ding, X. Gong, H. Jiang, L. Tang, "Two-Bit Lifting for Ternary SIS: Polynomial-Time Collision Attacks on LtHash", 2026, https://eprint.iacr.org/2026/2083                                                                                                                                            | Why 32-bit lanes: LtHash16 falls to about 2^81 hash queries; LtHash32 extrapolates to about 2^160 (estimate). Taken from the survey, not re-verified.         |
| MuHash                                     | Bellare and Micciancio 1997 (above); Bitcoin Core MuHash3072                                                                                                                                                                                                                                            | Not chosen. 8.6 µs per update with JS BigInt, plus a modular inversion.                                                                                       |
| Elliptic curve multiset hash               | J. Maitin-Shepard, M. Tibouchi, D. F. Aranha, "Elliptic Curve Multiset Hash", The Computer Journal 2017, https://arxiv.org/abs/1601.06502                                                                                                                                                               | Not chosen. 148 µs per update in JS.                                                                                                                          |
| XOR and modular-sum fingerprints           | D. Wagner, "A Generalized Birthday Problem", CRYPTO 2002, https://www.iacr.org/archive/crypto2002/24420288/24420288.pdf                                                                                                                                                                                 | Not chosen as a certificate: forgeable (C5's sums were forged 20 of 20). The cells use XOR only as a hint.                                                    |
| Merkle search trees, prolly trees          | A. Auvolat, F. Taïani, "Merkle Search Trees: Efficient State-Based CRDTs in Open Networks", SRDS 2019; AT Protocol repository spec, https://atproto.com/specs/repository; Dolt prolly trees, https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree/                                      | Not chosen. 132-215 µs per update in JS (okra), 4 RTT to diff, 1.6-3.5 MB at d = 1,000.                                                                       |
| Merkle Patricia tries                      | G. Wood, "Ethereum: A Secure Decentralised Generalised Transaction Ledger", 2014, https://ethereum.github.io/yellowpaper/paper.pdf                                                                                                                                                                      | Not chosen. Many hashes per update and a round trip per level.                                                                                                |
| Version vectors with exceptions            | D. Malkhi, D. Terry, "Concise version vectors in WinFS", Distributed Computing 2007, doi:10.1007/s00446-007-0044-y; R. Gonçalves, P. S. Almeida, C. Baquero, V. Fonte, "DottedDB: Anti-Entropy without Merkle Trees, Deletes without Tombstones", SRDS 2017, doi:10.1109/SRDS.2017.28                   | Measured (C6). Rejected above.                                                                                                                                |
| Heads exchange (hash-graph reconciliation) | M. Kleppmann, H. Howard, "Byzantine Eventual Consistency and the Fundamental Limits of Peer-to-Peer Databases", 2020, https://arxiv.org/abs/2012.00472                                                                                                                                                  | Not chosen. On Peerbit's wide DAG the heads alone cost about 32 B per element.                                                                                |
| Hybrid logical clocks                      | S. Kulkarni et al., "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases", 2014, https://cse.buffalo.edu/tech-reports/2014-04.pdf                                                                                                                                        | **Used for the hint only**: rows above R's snapshot timestamp go to X, and `hlcProved` sizes the first flight. Soundness never depends on a clock.            |

**Residual risks.**

- The interleaved equal-count gap stays slow (10 round trips) until change 2 is
  measured.
- AES-256-CTR as an LtHash expander is not a published parameter set. The
  conservative alternative is ChaCha20 at 3.21 µs (D17).
- The harness modelled one visible peer and no libp2p transport, and it could
  not model a sender that streams cells until told to stop. M0 P5 has since
  run the mechanism cross-process over libp2p with one and two donors (192
  runs, 0 false readies).
- The per-write total of about 2.4 µs was a sum of measured parts. Measured in
  the product (M0 P4) it was 5.5-35 µs p50 inline, so the anchor moves to a
  worker; the main thread then pays 1.8-5.6 µs p50.

## 12. Owner decisions needed

**2026-10-05: the owner accepted every recommendation below (D1-D18).** Work
proceeds with M0, then M1, in shared-fs only.

**After M0 (2026-10-05): D3 is back with the owner.** K0 fired on its "never
dropped" branch (section "M0 results"). D15 and D17 keep their choice, with
corrected figures; D10 now files U-37.

1. **D1. The new promise.** Ready means: J holds everything every connected or
   live visible peer held at its snapshot, and at least one of those peers was
   a ready full replica in that same answer. Invisible peers are out of scope,
   in writing. _Recommendation: accept._
2. **D2. No peer visible on a fresh join.** Stay gated, with no timer
   fallback. Offline-first stays available through warm reopen,
   `allowPartialWrites` and `assumeComplete()`. _Recommendation: stay gated._
3. **D3. A Required peer that does not answer.** (A) Keep J gated; the bound is
   the caller's timeout, whose `ETIMEDOUT` names the peer. (B) Exclude it after
   the attempts (35 s); this brings back the wrong ready for a creator busy for
   longer than that next to a fast stale replica. K0 never switches to B on
   its own: if pubsub lingers, J waits for its `unsubscribe`. Only if P1 shows
   dead subscribers are never dropped does this decision come back.
   _Recommendation: A._

    **Reopened after M0 P1 (2026-10-05).** P1 showed that dead subscribers are
    never dropped on the dead peer's fanout parent (36 of 36), or on any peer
    when it had no parent (82 of 82), so A as accepted would gate J until a
    crashed peer returns. The options now:

    | Option               | "R left" means                                                                                                                 | Wrong ready? | Cost                                                                                                                                                                                                      |
    | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | A as accepted        | pubsub `unsubscribe`                                                                                                           | no           | after most crashes J stays gated until R returns; every `awaitWriteReady` times out                                                                                                                       |
    | **A' (recommended)** | R is unreachable on the route table, re-read on libp2p `peer:disconnect` / `peer:connect` and fanout `peer:unreachable` events | no           | private reads (`pubsub.routes.isReachable`, `pubsub.peers`, already used at `src/index.ts:10200-10246`, `11185`) until U-37; half-open socket: 120 s; hung peer: never, so the caller's timeout bounds it |
    | B                    | the attempts end (35 s)                                                                                                        | **yes**      | a creator busy for more than 35 s next to a fast stale replica can be missed                                                                                                                              |

    A' keeps A's guarantee: a busy but connected creator stays reachable, so it
    stays Required. It fired 4-24 ms after every `kill -9` and transport stop
    in P1. The design text marked "pending D3" assumes A'.
    _Recommendation: A'._

4. **D4. A peer that leaves while J lacks rows only it had, or before it
   answered.** Block until it returns, or proceed and record `gaps` in the
   proof and status (`missing: "unknown"` when it never answered, after its
   attempt in flight ends, which absorbs reconnect flaps). _Recommendation:
   proceed and record; blocking turns a closed laptop lid into an indefinite
   outage._
5. **D5. Format.** Ship as store salt `/shared-fs/v9.2` plus the RPC field
   now, and fold the field into v10 when v10 resumes, rather than waiting for
   the paused v10. _Recommendation: ship as v9.2._
6. **D6. Warm reopens as donors.** M1 counts a warm reopen as a qualified
   donor, labelled `warm`. From M2 only `warm-fresh` qualifies.
   `requireFreshOnReopen` stays opt-in. _Recommendation: accept._
7. **D7. Open-mode stores.** Accept self-reported qualification, with the
   Sybil caveat documented. Trusted identity is required only when access
   control is on. _Recommendation: accept._
8. **D8. Two contract fixes in M1.** Scheduled GC requires readiness, and
   `allowPartialWrites` never arms Guard D. _Recommendation: yes._
9. **D9. Write-path losses.** Fix E1 (an equal-bytes save over an unseen head
   is a no-op, `src/index.ts:6651-6669`) and E2 (mode or mtime-only changes
   dropped) as a separate change. _Recommendation: yes, separately._
10. **D10. Upstream.** File the merged U-36 now, with the mechanism in
    section 10 (D18); file U-37 only if K0 fires;
    hold U-38 for M4. _Recommendation: yes._ After M0: K0 fired, so U-37 is
    due, together with the other M0 upstream reports in section 10.
11. **D11. Operator escape.** Add `assumeComplete()` and
    `--assume-complete`, persisting source `operator`. _Recommendation: yes._
12. **D12. Optional layers.** Decide on signed frontiers (M4) and
    per-operation readiness (M5) after M1 telemetry (`writers-unheard`,
    time to ready) is in. _Recommendation: defer._
13. **D13. Today's gate.** Record the 6k-file partial certification as a
    correctness bug now and correct the README's "Nothing is lost".
    _Recommendation: yes._
14. **D14. An idle peer whose messages to J were all lost.** Late answers
    count and any later sign of life re-asks, but if R is idle and three
    headers and a notice were all lost, nothing triggers again. (A) No new
    timer: the caller's timeout bounds it, and telemetry counts how often a
    wait ends that way. (B) Bounded re-asks, for example one more attempt at
    60 s and at 120 s, then stop; they can never make J ready. _Recommendation:
    A, and revisit with M1 telemetry._
15. **D15. Maintained cells and anchor on every peer (revised 2026-10-05).**
    Every open replica keeps 4,096 cells and an LtHash32 per scope, gated or
    not, at about 2.4 µs per row change (estimate from measured parts) and
    184 KB per scope, persisted at clean close. In return, answers need no
    scan, sort or encoder, joiners never re-hash their store, and a collision
    can only delay readiness. This replaces the earlier "salt per responder
    open", which cost 0.7 s per peer at 1M rows and failed the collision test.
    _Recommendation: accept._ After M0 P4 the figures are: a worker thread
    for the anchor; main thread p50 1.8-2.6 µs per add and 3.2-5.6 µs per
    replace (5.5-35 µs inline); plus a compact id → head map of about 13 MB
    at 200k rows and 57 MB at 1M, persisted with the cells. The choice
    stands; the owner may want to note the memory.
16. **D16. `ChangesetManifest` in the namespace scope.** Ready then also covers
    every changeset turn a contained peer held, so `changesetStatus` agrees
    with readiness. The alternative is to state in section 2.3 that changeset
    completeness is not covered. _Recommendation: include._

17. **D17. Anchor expansion and cell format.** (A) AES-256-CTR keyed by the
    entry hash, IV as the domain tag: 2.10 µs, not a published LtHash
    parameter set. (B) ChaCha20 keyed the same way: 3.21 µs, the conservative
    choice. (C) BLAKE3 XOF, as in Solana's LtHash: 4.94 µs in wasm. AES-128 is
    out (its 128-bit key caps expansion collisions at about 2^64, estimate).
    The cells use our own format, not `@peerbit/riblt`'s wire format.
    _Recommendation: A, switching to B if a crypto review objects; the wire
    format does not change._ After M0 P4: 2.10 µs holds only in a small heap.
    In the product the expansion's 4 KiB allocation makes it 6.4-7.7 µs at a
    477 MB heap and 20-52 µs at 1.9 GB. ChaCha20 and BLAKE3 allocate the
    same way, so B does not avoid this; a worker does, for any choice.
18. **D18. End state.** Ask upstream for U-36 as the mechanism of section 10
    (per-segment cells over full hashes, a per-segment LtHash, a streamed
    sender, a completion signal with `D_range`), and drop shared-fs's own cells
    at M3. The benchmarked U-36 sketch with 64-bit cells must not ship.
    _Recommendation: accept and report to the upstream owner._

## M0 results (2026-10-05)

The six M0 probes ran on shared-fs 0.16.5 and the Peerbit 5.4.10 cohort, on a
shared machine with other load (load averages are given in the raw results).
Full answers, evidence paths and run counts are in
`evidence/m0/RESULTS.md`; raw data is in `evidence/m0/p1`, `p2p3`, `p4p6`
and `p5`.

### What each probe found

| Probe                        | Question                                                                          | Answer                                                                                                                                                                                                                                       | Consequence for M1                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| P1(a) unclean leave          | How long does pubsub keep a dead subscriber, and does it ever emit `unsubscribe`? | The transport notices in 4-24 ms. Pubsub drops the peer only on peers that hear its fanout parent's PeerUnavailable (16-40 ms). The parent never drops it (36/36), nor does anyone when there was no parent (82/82); still listed at 20 min. | K0 fires on "never dropped": D3 goes back to the owner. Departure is read from route reachability on transport events (option A'). |
| P1(a) half-open, hung        | Does anything drop a peer whose sockets stay open?                                | Half-open: only the 120 s TCP inactivity timeout. Frozen process: nothing (0/30 `unsubscribe`).                                                                                                                                              | Such a peer stays Required until the caller's timeout; status names it "reachable, silent". Not a wrong ready.                     |
| P1(a) U-35                   | Does pubsub's own `onPeerUnreachable` run?                                        | Never (0/154): fanout shares the routes and removes the peer first.                                                                                                                                                                          | M1 never uses pubsub `unsubscribe` or pubsub `peer:unreachable` as a departure signal. Feeds U-37.                                 |
| P1(b) stale row at a fresh J | Does a dead peer's replication row cause replication events at a fresh joiner?    | No (107/107); the row never reaches the joiner. A dead or hung peer was relayed as a pubsub subscriber in 5/107 runs, unreachable on the route table.                                                                                        | `unconfirmed` is safe and, for a fresh J, vacuous. Discovery keeps filtering subscribers by reachability.                          |
| P2(a) entries log            | Does `getHasNext` find the CUT of a head J never held, after reopen?              | Yes whenever J holds the CUT, also after a restart from disk with no network. J does not hold it after a unique re-put of the same id (6 of 15 CUTs held in real shared-fs).                                                                 | Sound and durable; no CUT-target index. Incomplete only against a stale R (see P2(b)).                                             |
| P2(a) trust log              | Same, in the trust log                                                            | A fresh joiner never holds a revocation CUT for a grant it never held: `TrustedNetwork` rejects it.                                                                                                                                          | Fine against an up-to-date R; against a stale R see P3.                                                                            |
| P2(b) older head             | J holds the CUT of d, not d; it pulls the older head h. What is indexed?          | h is indexed: the deleted document comes back and replicates to the deleter (3/3). Variant: J holds a newer row for the id, lacks the CUT; h is logged, never indexed, and nothing names it.                                                 | Containment holds in the stated case (upstream bug reported). The variant needs a new explained class, `ignored-older`.            |
| P2(c) replace                | Does a replace always name the replaced head in `meta.next[0]`?                   | No: not for `unique` puts over a present row, not for remote forks, not for independent unique puts. No replace reports the old head as removed. Ignored arrivals dispatch empty events.                                                     | The tap keeps an id → head map and ignores empty events. The `meta.next` rule is dropped.                                          |
| P3 revocation                | Does a joiner always see a revocation as a delete?                                | Only if it held the relation. A fresh joiner sees no event and no CUT (end state correct). A stale peer can push the revoked grant: J trusts the writer again for about 1 s, until A re-offers the CUT.                                      | The trust listener re-evaluates on any change, from current rows. The revocation window is stated (2.3, 5); upstream report filed. |
| P4 tap cost                  | Cells plus anchor per change in the real change tap, at 50k and 200k rows         | Inline p50 5.5-15 µs per add and 9.5-35 µs per replace; p90 of adds 15-34 µs at 200k. With the anchor in a worker: main thread 1.8-2.6 µs and 3.2-5.6 µs.                                                                                    | K2's 20 µs fails inline; M1 hosts the anchor in a worker.                                                                          |
| P4 why                       | Where does the time go?                                                           | Head string decode 2.0-2.6 µs; the anchor slows with heap size (4 KiB allocation per expansion; 20-52 µs at a 1.9 GB heap); cells 0.23-0.31 µs.                                                                                              | Fast fixed-shape decoder or digests; anchor in a worker (any cipher).                                                              |
| P4 shadow check              | Does maintained state equal a fresh build?                                        | One peer: always. Two peers with concurrent same-id re-puts: no (4/4), because change events can arrive out of index order. With a replace-verify step: yes (3/3).                                                                           | The tap re-reads the indexed head on every replace or stale removal.                                                               |
| P4 restore, freeze, query    | Restore vs rebuild; freeze; rows above `hlc`                                      | Cells plus anchor restore in under 1 ms, the map in 57-131 ms, against a 2-4 s rebuild at 204k rows. Freeze p50 16-31 µs inline, 52-167 µs via the worker. A `__context.modified` range query is exact; `count()` under 1 ms.                | Persist the map too, after the drain. No timestamp side table; warm the query's lazy index at open; `hlc` is wall time in ns.      |
| P5 end to end                | Does the session work over one-way RPC, cross-process, and how fast?              | Yes: 192 runs, 0 false readies, shadow equal in all. Latency in the table below.                                                                                                                                                             | Transport and session flow carry over. Three tunings (step 5's T = 256, gapEst with `hlcProved = 0`, one pull queue).              |
| P6 tags                      | Can put paths carry `meta.data` tags?                                             | No: shared-log overwrites `meta.data` with `MinReplicas` on every append.                                                                                                                                                                    | M1 does not need tags. U-36 part (b) and K3 need a separate tag field.                                                             |

### P5 latency, cross-process (n = 20 per batch, two batches)

| Scenario                         | Proof-based (P5) p50 / p95                 | Today p50 / p95            |
| -------------------------------- | ------------------------------------------ | -------------------------- |
| Plain dial, 1 file               | 0.28-0.36 s / 0.43-0.53 s                  | 5.45-5.49 s / 5.57-5.77 s  |
| Plain dial, 400 files (805 rows) | 0.93-0.96 s / 1.05-1.09 s                  | 6.07-6.11 s / 6.25-6.84 s  |
| Donor writing every 1 s          | 0.82-0.93 s / 1.13-1.81 s                  | 0 of 20 ready within 20 s  |
| Two donors, 400 files            | 1.06-1.38 s / 1.17-2.58 s                  | 6.16-6.49 s / 6.27-8.08 s  |
| Warm rejoin, d = 0 (proof only)  | 0.38-0.44 s / 0.49-0.57 s, 1 RTT, 148 B in | ready at open, 0.32-0.35 s |

The M1 exit target for a small plain dial (p50 ≤ 0.6 s, p95 ≤ 1.5 s) is met by
the prototype. At 400 files the p50 is bound by Peerbit's transfer of the
rows: the proof finished 0-1 ms after the last row arrived.

### Kill points and the branch M1 takes

| Rule                        | Result                                                                                                     | Branch                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| K0, linger over 60 s        | Yes, and on the parent or with no parent the subscriber is never dropped                                   | **"Never dropped" branch: D3 goes back to the owner** (section 12, recommended A'). U-37 is due. |
| P2(a) fallback              | The lookup works whenever J holds the CUT, durably; J lacks CUTs only when `canPerform` rejected them      | Not taken: a CUT-target index from the tap would not see rejected CUTs either                    |
| P2(b) fallback              | The stated case is indexed (not "logged but never indexed"); the variant is logged but has no CUT to fetch | Not taken as written; `ignored-older` instead                                                    |
| K2 (M1 kill point, from P4) | Inline upkeep exceeds 20 µs at 200k rows                                                                   | Anchor in a worker; K2 now measures the main thread (p90) and the worker's backlog               |

M1 continues in shared-fs only on Peerbit 5.4.10. Everything except the
departure rule can start now; the departure rule waits for D3.

### What changed in this document

| Section                | Change                                                                                                                                                                                                                                                                       | Probe         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Status, 1, 12          | D3 reopened with options A, A' and B; D10 files U-37; D15 and D17 carry corrected figures                                                                                                                                                                                    | P1, P4        |
| 1 (what changes), 4.1  | Per-change cost replaced by the product measurement; anchor in a worker; id map added                                                                                                                                                                                        | P4            |
| 2.1, 2.2 item 2        | "Connected" and departure defined by route reachability, re-read on transport events (pending D3); the pubsub assumption removed                                                                                                                                             | P1            |
| 2.3                    | New row: a fresh J can trust a revoked grant that a stale peer re-introduces                                                                                                                                                                                                 | P3            |
| 2.4, 6.2, 6.4, 4.12 #2 | Latency rows use the P5 cross-process numbers; new rows for a crashed and a hung peer                                                                                                                                                                                        | P1, P5        |
| 4.3                    | `hlc` is the highest `__context.modified` (wall time, u64 ns)                                                                                                                                                                                                                | P4            |
| 4.4                    | Id → head map (compact) replaces the `meta.next[0]` rule; tap rules (class scoping, synchronous reads, empty events, replace verify, attach before ingest, digests); anchor in a worker with a sequence-numbered freeze; restore and freeze figures; persist after the drain | P2(c), P4     |
| 4.5 steps 3-5, 7-9     | Rows above `hlc` by a range query (no side table); `above` term off when `hlcProved = 0`; wait for T = 256 while sync delivers; one pull queue across sessions; `ignored-older` after a pull                                                                                 | P4, P5, P2(b) |
| 4.6                    | New explained class `ignored-older`; the open case resolved (h is indexed; resurrection reported upstream); where J lacks CUTs                                                                                                                                               | P2            |
| 4.7, 4.9               | `unconfirmed` confirmed; departure paragraph; transport events as triggers; trust re-checks on any change                                                                                                                                                                    | P1, P3        |
| 4.10, 4.11, 6.3        | Persisted file holds the id map; memory, seed, snapshot and storage rows; the private reachability read under A'                                                                                                                                                             | P1, P4        |
| 4.12                   | Cases 14, 16, 39 updated; cases 41-45 added                                                                                                                                                                                                                                  | P1-P4         |
| 5                      | Revocation gap made concrete                                                                                                                                                                                                                                                 | P3            |
| 6.1, 11.1              | Note that the 2.4 µs estimate is superseded; residual risks updated                                                                                                                                                                                                          | P4, P5        |
| 8                      | Tests 18 and 49 changed; tests 52-57 added                                                                                                                                                                                                                                   | P1-P4         |
| 9                      | M0 outcome; M1 content (worker, id map, `ignored-older`, T = 256, pull queue, reachability); K2 on the main thread; K3 needs a tag field; surfaces list                                                                                                                      | all           |
| 10                     | U-36(b) cannot use `meta.data`; U-37 filled in with P1's evidence; four new upstream reports                                                                                                                                                                                 | P1-P3, P6     |

## Appendix: evidence

- `evidence/m0/RESULTS.md` and `evidence/m0/{p1,p2p3,p4p6,p5}/`: the M0
  probes (section "M0 results").

- `~/git/shared-fs-evidence/unblocked-20261003/quiet-window/`: today's 5.34 s
  breakdown, the donor-confirmed prototype and its patch.
- `evidence/map-current-contract.md`, `map-primitives.md`,
  `map-correctness-model.md`: the three maps this design builds on.
- `evidence/design-upstream-sync.md`, `design-digest-visible.md`,
  `design-semantic-safety.md`, `design-signed-frontiers.md`: the candidates.
- `evidence/upstream-sync/reconcile-run2.out`, `riblt-empty.out`: section 6.2
  and the zero-symbol guard of the earlier mechanism.
- `evidence/correctness-model/zz-starve*.out`, `zz-staleview.out`: starvation
  and stale-view harm.
- `evidence/semantic-safety/results.ndjson`: partial certification at 6k files
  and the footprint measurements.
- `evidence/signed-frontiers/results.txt`: a fresh joiner's log keeps every
  earlier CUT.
- `evidence/primitives/riblt-bench.out`, `probe.out`: RIBLT decode cost, salted
  hash cost, head and id sizes.
- `evidence/digest-visible/digest-bench.out`, `drill-sim.out`: digest and
  drill costs.
- `sota/survey-set-reconciliation.md`, `survey-authenticated-structures.md`,
  `survey-causal-sync.md`: the three surveys behind section 11.1.
- `sota/harness/`: the shared benchmark harness and all six candidates
  (`cand/`), with its README (method, links, workloads).
- `sota/c4/out/table-arms-wan.md`, `sim-c4-arms.ndjson.gz`,
  `decodeprobe.ndjson`, `parts-c4-quiet.ndjson`, `jarrival-c4-quiet.ndjson`:
  section 6.1 tables A and D.
- `sota/c1/out/summary-tables.md`, `adv.ndjson.gz`: table B and the collision
  results of the list arms.
- `sota/skeptic/upkeep.ndjson`, `xmid.ndjson`, `adv.ndjson`: table C, the
  interleaved-gap case, and the anchored collision runs.
- `sota/decision/xof-256.ndjson`, `xof-ds.ndjson` (and their `.mjs`): the
  anchor expansion benchmark.
- `sota/RESULTS.md`: the benchmark summary tables of section 6.1.

## Review notes

A review raised 25 findings (R1-R25). Each was checked against the cohort
code and the evidence before it was applied.

| #   | Finding                                                                                           | Disposition                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Fetch timeouts excluded an honest busy donor as `unsubstantiated`                                 | Applied. Confirmed: `join` returns `Promise<void>` (`@peerbit/shared-log index.d.ts:1124-1131`). Exclusion now needs a provable lie; a failed fetch keeps R `reconciling` and retries on events (4.5 steps 8-9; tests 26-27).                                          |
| R2  | `StateNoticeV1` let a peer qualify on a snapshot taken while it was gated                         | Applied. A notice is a trigger for a fresh session, bound to `openNonce`; only the containing session's header qualifies (2.2 item 3, 4.3, 4.8; test 8).                                                                                                               |
| R3  | Seen-delete map (cap 10,000) overflows on ordinary GC history and gates J forever                 | Applied. Confirmed: 24 CUTs for 12 retired versions. The map is gone; `superseded` is an on-demand lookup in J's log (`log.entryIndex.getHasNext`); rejections are bounded by in-flight batches; `map-overflow` removed (4.6; test 43).                                |
| R4  | `retired` keyed by document id explains away legitimate re-puts (GC recovery, trust re-grant)     | Applied. Confirmed at `src/index.ts:16232-16243` and `identity-graph.js:193-196`. Only a held entry whose `meta.next` includes the exact head explains it (4.6; tests 40, 42).                                                                                         |
| R5  | A replicator-only peer whose Subscribe was lost became `unconfirmed` after one attempt            | Applied. Peers with a sign of life since open are live and Required with full attempts (2.1, 4.7; test 16). Merged with R16.                                                                                                                                           |
| R6  | A connection flap of an unanswered peer marked it `left` at once                                  | Applied. Confirmed: a session reset emits `unsubscribe` (`@peerbit/pubsub index.js:3328-3333`). New state `left-unanswered`, recorded as `gaps` with `missing: "unknown"` if it stays away (4.7, D4; test 19).                                                         |
| R7  | `rejected-untrusted` checked against an older trust snapshot and never revisited                  | Applied. `TRUST_V1` is frozen after `NAMESPACE_V1` in one session; the verdict is provisional and re-checked on trust changes and when C grows (2.2 item 4, 4.6; test 36).                                                                                             |
| R8  | `Log.has` true before the index holds the row                                                     | Applied. Confirmed at `@peerbit/log log.js:3756`, `3785`. Containment is now by index row head; a logged but unindexed head waits for its change event (2.1, 4.5 step 7; test 44).                                                                                     |
| R9  | `silent` and `busy` could only end on best-effort messages from R                                 | Applied in part. Notices are directed; busy peers are re-asked when another session completes; any sign of life re-asks. The remaining all-messages-lost case is D14 rather than a new timer, per the no-polling rule.                                                 |
| R10 | A crash lost the seen-delete map; reopen then excluded or resurrected                             | Applied through R3: the log lookup survives reopen (4.10, case 26; test 9 extended with a lagging donor).                                                                                                                                                              |
| R11 | `TRUST_V1` pulled from the entries log                                                            | Applied. Confirmed: the trust graph is a separate `Documents` (`@peerbit/trusted-network controller.js:180-200`). Log id, `has`, `join` and lookups are per scope (4.2, 4.3; test 38).                                                                                 |
| R12 | `trust-pending` heads were retried only on a trust-graph change                                   | Applied. Also re-classified when a peer's `TRUST_V1` scope becomes contained or C changes (4.5 step 8, 4.9; test 37).                                                                                                                                                  |
| R13 | `ChangesetManifest` exclusion reason was false (its id is content-addressed)                      | Applied. Confirmed at `src/index.ts:4194-4195`, `7449`. It is now in `NAMESPACE_V1` (4.2, D16; test 14).                                                                                                                                                               |
| R14 | Seen deletes keyed by id miss Guard D resurrection; recorded at `canPerform`, before admission    | Applied with R3 and R4: the lookup reads admitted entries in J's log, by exact head (test 41).                                                                                                                                                                         |
| R15 | A late RPC answer is discarded, so a recovered peer stays `silent`                                | Applied, reworked. Confirmed at `@peerbit/rpc controller.js:273-279`, `662`. All messages are one-way `rpc.send({to})`, matched by `sessionId`, so late answers count (4.3; test 17). The proposed `reason: "late"` notice is not needed.                              |
| R16 | Same as R5, plus Required and `unconfirmed` disagreed                                             | Applied with R5. `unconfirmed` peers are not Required, and the predicate no longer lists them (2.1, 4.8).                                                                                                                                                              |
| R17 | M1 cannot delete the private route reads that discovery still uses                                | Applied. Confirmed at `src/index.ts:11174`, `11184-11185`, `11281`, `11409`, `11754`, `14013`. M1 removes only the idle read and the fence's route read; discovery moves in M2; code estimate corrected (1, 4.11, 6.2). The cited §9 phrase does not occur in the doc. |
| R18 | Donor memory and resolve wire size were underestimated                                            | Applied. Heads are 49-character CIDs and ids about 52 characters. Re-sized with typed arrays, no id strings in memory, and a per-responder memory cap (4.4, 6.2).                                                                                                      |
| R19 | Per-snapshot salt makes K2 fire and leaves joiner cost out                                        | Applied. Salt per responder open (D15); the maintained set moves into M1 with a shadow check; joiner cost added to 4.5, 6.2, 6.3; the "no per-row cost" claim and the cache cite were corrected.                                                                       |
| R20 | RIBLT budget allowed about 6× list-mode bytes; count difference does not bound the set difference | Applied. Budget capped at wire parity, `max(64, ⌊count_R/3⌋)`, and n up to 8192. The suggested symbol-0 seeding was not adopted: symbol 0 gives count and XOR, not the size of the difference (4.5 step 4; test 29).                                                   |
| R21 | First scheduled GC delay is 5-95 min, not 5 min ± 20%                                             | Applied. Confirmed at `src/index.ts:364-368` (3, 2.4).                                                                                                                                                                                                                 |
| R22 | 6k-file range omitted the 96.7 s run; missing-row counts came from 2 runs                         | Applied. Confirmed in `results.ndjson`: 62-97 s, n=4, counts from 2 runs (1, 2.4).                                                                                                                                                                                     |
| R23 | Sidecar parser rejects the new sources; `StateNoticeV1` cannot be a response sent with `rpc.send` | Applied. Parser allowlist and proof shape check added to M1 (4.10). With one-way messages every variant, the notice included, is the RPC's query type (4.3).                                                                                                           |
| R24 | Wrong exclusion reason and several wrong cites                                                    | Applied. Cites now point at `program.d.ts:52-57`, `src/index.ts:4230`, `2525-2542` (described correctly) and `11172-11194`; the seen-delete cite went with the map.                                                                                                    |
| R25 | "Silence never unblocks" rests on an unrun probe; D3 hid what K0 would bring back                 | Applied. 2.2 item 2 is stated as conditional on P1; K0 now waits for pubsub's `unsubscribe` instead of excluding on elapsed attempts; D3 lists both options and their consequences.                                                                                    |

No finding was rejected outright. Two parts of proposed fixes were not taken:
the `late` notice in R15 (one-way messages make it unnecessary) and symbol-0
mode seeding in R20 (it cannot measure the difference size).

**Revision of 2026-10-05.** After the benchmark of section 11.1, the proof
mechanism changed; the readiness rule, peer states, explain step and
milestones did not. Salted `u64` ids, the per-open salt, `ResolveV1`,
per-session `@peerbit/riblt` symbols and the sha256-of-sorted-list digest are
gone. They are replaced by maintained full-hash cells (a hint) and an LtHash32
anchor (the certificate), with list mode kept for recovery only and the cursor
idea dropped. Findings R18-R20 described the old mechanism; their concerns
(memory, joiner cost, the RIBLT budget) are now answered by section 6.
