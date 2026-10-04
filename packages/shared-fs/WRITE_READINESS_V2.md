# Write readiness v2: prove catch-up instead of waiting out a timer

Status: design for owner review, revised after a 25-finding review (see "Review
notes" at the end). Nothing is implemented. Code refs: `origin/master`
`2fd4f64b` (0.16.5, Peerbit 5.4.10, `@peerbit/shared-log` 16.0.40,
`@peerbit/document` 15.1.11). `src/index.ts:N` is
`packages/shared-fs/library/src/index.ts` (16,859 lines). `@peerbit/<pkg> file.js:N`
is the installed dist under `packages/shared-fs/library/node_modules`. Evidence
lives in `~/git/shared-fs-evidence/readiness-design-20261004/` (called
`evidence/` below) and `~/git/shared-fs-evidence/unblocked-20261003/quiet-window/`.
D1-D16 are the owner decisions in section 12.

This document picks one of four candidate designs and grafts parts of the other
three onto it. Section 11 has the candidates and their review scores.

## 1. Decision memo

**The question.** Write readiness ends with a fixed 5 s quiet window
(`WRITE_READINESS_SETTLE_MS`, `src/index.ts:2410`). The owner asked whether
something more rigorous than a timer can make correctness likely.

**The answer in one paragraph.** Yes, for every peer the joiner can see; no
local mechanism can do it for peers it cannot see. A joiner J asks each visible
peer R for a snapshot of R's namespace, as a list of salted entry-hash
fingerprints with a count and a digest. J then waits, driven by events, until
its index holds every entry in that snapshot or J can show why it never will
(J holds a later entry that supersedes it, or J rejected it). This is
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

| Finding                                                            | Measured                                                                                                                        | Source                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Plain dial of a 1-file store: every prerequisite met, then waiting | prerequisites at 0.23 s, writable at 5.34 s (n=6)                                                                               | `quiet-window/README.txt`, `results.ndjson`                             |
| A colleague saving every 1 s keeps a new machine read-only         | not ready after 30 s or 60 s; CLI mount fails at its 120 s default                                                              | `evidence/correctness-model/zz-starve*.out`; `cli/src/index.ts:889-893` |
| The window certifies partial views at 6k files                     | ready at 62-97 s (n=4) with 5,846/6,060 naming and 5,783/6,000 version rows, and 5,872/5,779 in another run (counted in 2 runs) | `evidence/semantic-safety/results.ndjson`                               |
| A wrong "ready" is not loss-free                                   | an equal-bytes save is silently lost; a `mkdir` splits a directory; a stale edit can win                                        | `evidence/correctness-model/zz-staleview.out`; `src/index.ts:6651-6669` |
| The prototype of this design                                       | 1 file 0.31 s, 400 files 0.95-0.99 s, donor writing every 1 s 0.66 s                                                            | `evidence/upstream-sync/reconcile-run2.out` (in-process, section 6)     |

**What changes.**

- A new readiness RPC program on the filesystem, with versioned one-way
  messages and a new store salt. This is a format break with no migration (D5).
- The quiet window, the 1 s re-check poll, the 100 ms double check, the
  "remote evidence" flag and its profile-event capture, and the private read of
  `syncronizer.pending` all go (`src/index.ts:10161-10188`, `10314-10471`,
  `3412-3480`). The readiness fence stops reading route hints. Bootstrap
  discovery and the GC peer gate keep their private `pubsub` reads until M2
  (section 4.11).
- Every responder keeps an in-memory element set once a peer has asked. There
  is no index column.
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
timeout; elements are salted per responder open over a maintained set; and an
entry in J's own log that supersedes a listed head (a CUT or a later put)
explains that exact head.

## 2. Definitions and guarantees

### 2.1 Terms

| Term            | Meaning                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Namespace row   | A `NamingEvent`, `FileVersion` or `ChangesetManifest` in the entries index. Not `FileChunk` or `BootstrapManifest`.                                                                                                                                                                              |
| Trust row       | A row of the `TrustedNetwork` trust graph (access-controlled stores only). It lives in a separate log, `trustGraph.log`.                                                                                                                                                                         |
| Entry           | The log entry behind a row. Identified by its hash (`__context.head`), which covers the row bytes and the signature.                                                                                                                                                                             |
| Element         | `u64` = first 8 bytes of `sha256(salt ‖ entryHash)`. R draws the salt at random once per open; it changes with R's `openNonce`.                                                                                                                                                                  |
| Snapshot S_R(t) | The set of elements of every namespace (or trust) row in R's maintained set at one epoch, frozen at time t_R.                                                                                                                                                                                    |
| Contained       | Every entry of S_R(t_R) is indexed by J (J's index of that scope has a row whose `__context.head` is that entry), or is explained. `Log.has` alone is not enough: the log commits before the index (`@peerbit/log log.js:3756`, `3785`).                                                         |
| Explained       | J will correctly never index it: J's log of that scope holds an entry whose `meta.next` includes it (superseded), or J's `canPerform` rejected it under the rules of section 4.6.                                                                                                                |
| Visible         | Subscribed to the readiness topic, or listed by the scope log's `getReplicators()`.                                                                                                                                                                                                              |
| Connected       | A readiness-topic subscriber that pubsub has not dropped. Pubsub emits `unsubscribe` when a peer becomes unreachable and when its session resets (`@peerbit/pubsub index.js:3328-3351`).                                                                                                         |
| Live            | A visible peer that is not connected but has sent J something since J opened: a replication announcement (`replicator:join`, `replication:change`), a readiness message, or a subscribe. A peer whose readiness Subscribe was lost (U-1) but whose replication traffic arrives is live.          |
| Qualified donor | In the `HeaderV1` of the session that J contained, R reported `writeReady`, a source in {creator, reconciled, warm, operator} (M2: `warm-fresh` instead of `warm`), a full replica, the same format, and, in access-controlled stores, an identity in J's trusted set. A notice never qualifies. |
| Required        | The connected and live visible peers at the moment of evaluation, plus any peer with a session in flight, plus any `left-unanswered` peer (section 4.7). Never frozen.                                                                                                                           |
| Dominance       | Every naming and content head in S is in J or is an ancestor of a row in J. Containment implies dominance. Every needless conflict type comes from a write that ignores an existing head (correctness map §2).                                                                                   |

### 2.2 What "ready" proves after this change

When a fresh address-open of a full replica turns `writeReady` with source
`reconciled`, J has proven, locally:

1. **Containment.** For every peer R in a set C, J indexes or explains every
   entry of S_R(t_R). t_R is no later than R's receipt of J's request.
2. **Every connected or live visible peer is accounted for.** At the moment of
   the decision, every Required peer is in C, or excluded for a provable lie
   (an inconsistent count or digest, an element R listed but left out of its
   own resolve answer, or a fetched entry that does not match what R
   resolved), or has left (recorded in `gaps` when J still lacked its rows,
   D4). Silence, `BUSY`, slowness and fetch timeouts never exclude a Required
   peer. This item assumes pubsub eventually drops dead subscribers; M0 probe
   P1 checks it, and K0 says what changes if it does not.
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

| Not proven                                                                                                            | Why                                                                       | What we do                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Rows held only by peers J cannot see (lost Subscribe with no other traffic, U-1; offline writers; stale creator, U-7) | No local mechanism can see them                                           | Stated in README; `writersUnheard` telemetry; optional frontier layer (M4)  |
| Rows any peer received after its snapshot                                                                             | Snapshot semantics; such writes are concurrent with J by definition       | Normal sync and conflict handling                                           |
| Rows of a peer that became visible only after ready                                                                   | The decision is made at one moment                                        | Same as above                                                               |
| Rows of a peer that left before answering and never came back                                                         | J never learned its set                                                   | Recorded as `gaps: {peer, missing: "unknown"}` (D4)                         |
| That a peer told the truth                                                                                            | Under-reporting looks like a lagging donor                                | Every Required peer must be contained, so one liar wins only if it is alone |
| That chunk bytes are present                                                                                          | A write needs chunk ids, not bytes                                        | Reads wait for chunks, as today                                             |
| Freshness of a warm reopen                                                                                            | Warm reopens trust their persisted proof (offline-first)                  | M2 freshness check and `warm-fresh`; opt-in `requireFreshOnReopen`          |
| GC safety                                                                                                             | Not readiness's job; arrival-age shields protect GC (at least 1 h to 2 d) | Unchanged; scheduled GC also gated on readiness now                         |
| Revocation enforcement                                                                                                | J cannot tell pre-revocation history from later writes                    | Unchanged (README "trust")                                                  |
| Write-path losses E1 (equal-bytes save) and E2 (mode/mtime-only change)                                               | These come from the write path, not from readiness                        | Separate fix (D9)                                                           |

### 2.4 Scenarios: today vs proposed

| Scenario                                                       | Today (5 s window)                                                           | Proposed                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Plain dial, 1-file store, idle donor                           | 5.34 s, measured                                                             | 0.3-0.6 s estimated cross-process; 0.31 s measured in-process                                   |
| Donor saving every 1 s                                         | never; mount fails at 120 s                                                  | 0.66 s measured in-process                                                                      |
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
| Truncated or lost answer                                       | not applicable (no answers)                                                  | detected by count and digest; never ready on it                                                 |
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
J opens (fresh, full replica, gated)
  │
  ├─ subscribe readiness topic; list visible peers (subscribers ∪ replicators)
  │
  ├─ per Required peer R (≤ 4 sessions in flight; one-way directed messages):
  │     OpenV1 ──► R freezes its maintained element set (salt, count, digest, provenance)
  │     ◄── HeaderV1 (counts whenever it arrives while the session is open)
  │     list pages (or RIBLT symbols when J is close to R) ──► D = R \ J
  │     drain D from index change events; pull the rest in batches of 256:
  │        ResolveV1 → heads → indexed? superseded? → scope log join(heads)
  │     residue: explained (superseded / rejected); provable lie → excluded;
  │              fetch failed → retried on R's next sign of life or arrival
  │     → R contained at t_R
  │
  └─ evaluate() after every event:
        phase ok ∧ every Required peer contained, excluded for a lie, or left
        ∧ some contained peer qualified in its own header ∧ trust scopes contained
        → persist proof (fsync) → flip → arm Guard D → write:ready → StateNoticeV1
```

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

The element is a salted `u64` of the entry hash:

- **Entry hash, not document id.** A re-put of a stable id with new bytes is a
  new entry, so it is required (skeptic finding b). J checks the index row's
  head, so re-puts are neither missed nor counted twice. This is the identity
  Peerbit itself reconciles, so U-36 later swaps the transport, not the
  semantics.
- **Salted per responder open.** R draws a 16-byte salt when it opens and keeps
  it for that open (it travels with `openNonce`). Rows written before the open
  could not be ground against it. A collision found after the salt is known
  hides only the grinder's own rows: to hide another writer's row y, an
  attacker needs an entry that collides with y specifically, a 64-bit second
  preimage. A writer that wants to hide its own rows can already withhold them
  (section 2.3), so the per-open salt gives up nothing that matters. A salt per
  snapshot would force a full re-hash and sort on both sides for every session
  (about 2.5 µs per row, `evidence/primitives/riblt-bench.out`), and rules out
  a maintained set (D15). Accidental collision chance is about n²/2⁶⁵ (about
  1e-9 at 200k rows).
- **8 bytes on the wire.** Full entry hashes would cost about 60 bytes each
  (12 MB at 200k rows) in list mode.

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

| J to R                                             | R to J                                                                                            | Notes                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenV1{sessionId[16], scopes, attempt:u8}`        | `HeaderV1{sessionId, scope, provenance, salt[16], count:u32, digest[32], symbols[≤32]}` per scope | every attempt of one session gets the same snapshot; `digest` = sha256 of the sorted little-endian element list; `TRUST_V1` is frozen after `NAMESPACE_V1` |
| `MoreSymbolsV1{sessionId, scope, from:u32, n:u16}` | `SymbolsV1{sessionId, scope, from, symbols[n]}`                                                   | RIBLT; n doubles from 32 up to 8192 (196 KiB)                                                                                                              |
| `ListPageV1{sessionId, scope, offset:u32}`         | `ListV1{sessionId, scope, offset, elems:u64[≤8192], done:bool}`                                   | 64 KiB pages                                                                                                                                               |
| `ResolveV1{sessionId, scope, elems:u64[≤256]}`     | `ResolvedV1{sessionId, scope, rows:{elem, head, docId, kind}[]}`                                  | an element R listed and leaves out here is a provable lie: R is `unsubstantiated`                                                                          |
| `CloseV1{sessionId}`                               | none                                                                                              | frees R's state early                                                                                                                                      |
| any                                                | `ErrorV1{sessionId, code: BUSY \| UNSUPPORTED \| EXPIRED \| SCOPE}`                               | explicit refusals; `BUSY` promises a `StateNoticeV1` when capacity frees; `EXPIRED` makes J open a new session                                             |
| none                                               | `StateNoticeV1{openNonce, provenance, reason}`                                                    | sent with `to:` each peer that had a session or a `BUSY` with R in this open (at most 256), when R becomes ready or `warm-fresh`, or frees capacity        |

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

### 4.4 Responder rules (every open replica answers)

- Every opened replica answers, gated or not, full or partial, and reports its
  provenance honestly. A warm reopen reports `warm`, not the source it
  persisted.
- **Maintained element set.** Built lazily: the first `OpenV1` after R opens
  starts one projected index scan of `{id, kind, __context.head}` per scope
  (measured about 8 µs per row including hashing: 6,030 rows, 37-43 ms scan
  plus 7-10 ms hash). From then on R keeps the set current from that scope's
  change events: one salted hash and one update per added or removed row.
  A replace emits only `added` (`@peerbit/document program.js:3390-3432`,
  primitives map A6), so each record also keeps an 8-byte hash of the
  document id, and a re-put drops the old element. Changes that arrive during
  the seed scan are buffered and applied after it. A record is
  `{element, head digest[32], idHash, addedEpoch, removedEpoch}` in typed
  arrays. A removed record stays until no open snapshot predates its removal.
- **Snapshot.** A snapshot is the set at one epoch. R copies the elements
  visible at that epoch, sorts them (about 20-30 ms at 200k rows, estimate) and
  computes the digest once. Every session opened at the same epoch shares it.
  t_R is the freeze time. With both scopes, R freezes `TRUST_V1` after
  `NAMESPACE_V1`.
- **RIBLT encoder.** Built lazily per snapshot, only when a session asks for
  symbols.
- **Resolve** looks elements up in the maintained set, restricted to the
  snapshot's epoch: O(1) per element, no scan. `docId` and `kind` come from R's
  own log entry for the at most 256 rows of a batch, so no id strings sit in
  memory.
- **Caps.** 4 sessions per peer, 16 in total, and a memory cap per responder
  over the maintained set and live snapshots (default 64 MB; M0 P4 sets it).
  Beyond any cap R replies `BUSY` and remembers the requester for a
  `StateNoticeV1`. A session expires after 30 s idle (memory bound, never
  evidence).
- **Late requests.** R answers every request it receives, however late. J
  decides whether the session is still open.

### 4.5 Joiner session against one peer

1. Send `OpenV1` (both scopes in access-controlled stores). Receive one
   `HeaderV1` per scope (S_R at t_R). A header that arrives after an attempt
   timed out still counts while the session is open.
2. `count == 0`: R's scope is empty; R is contained at once (the genesis-only
   creator case).
3. Compute E_J under R's salt. J keeps E_J per (R, `openNonce`) while it is
   gated: one projected scan of J's own index, shared by every peer (4-6 µs per
   row, primitives map B5), plus one salted hash per own row per peer salt
   (about 2.5 µs), then kept current from J's change events. At 200k rows the
   first session costs J about 0.8-1.2 s of scan plus about 0.5 s of hashing per
   peer (estimates). There is no index-wide epoch to cache against; the
   per-node caches at `src/index.ts:2525-2542` are a different thing.
4. Choose a mode by counts, never by time:
    - **RIBLT** when `|E_J| > 0` and `|count_R − |E_J|| ≤ 256`. The count
      difference is only a lower bound on the set difference: J can hold k rows
      R lacks while lacking k of R's, with equal counts. So the symbol budget
      is capped at wire parity with list mode, `max(64, ⌊count_R / 3⌋)`
      symbols (24 B per symbol against 8 B per listed element), and J then
      switches to list mode. RIBLT plus the fallback therefore costs at most
      about twice list mode. Decode CPU also limits RIBLT to small differences
      (1,449 symbols took 1.25 s at n = 100k, `evidence/primitives/riblt-bench.out`).
      J always consumes at least one symbol, because `@peerbit/riblt` 1.2.0
      reports `decoded() == true` before any symbol
      (`evidence/upstream-sync/riblt-empty.out`). After decoding, J rebuilds
      R's set from E_J and the decoded differences and checks `count` and
      `digest`.
    - **List** otherwise. Page to `done`, then check `count` and `digest`. A
      mismatch is `incomplete`; a second mismatch from the same `openNonce` is
      `inconsistent`. This closes skeptic finding (a), truncation.
5. D = R's elements not in E_J. Empty: R is contained.
6. **Drain by events.** For every row J's index adds, the change event
   carries `__context.head` (primitives map, A6) and fires after the index
   write. J hashes the head under each live session's salt and removes it from
   D. O(1) per row per session.
7. **Pull in a self-clocked batch.** One batch of up to 256 elements is in
   flight per session. Take them from D and `ResolveV1` them. Check each
   resolved row: a `kind` outside the scope is a lie. Then for each head:
    - drop it if J's index has the row at that head (an index lookup by
      `docId`, comparing `__context.head`);
    - drop it if it is explained (section 4.6);
    - if `Log.has` is true but the index lacks it, leave it in D for its change
      event: the log commits before the index (`@peerbit/log log.js:3756`,
      `3785`; `@peerbit/document program.js:1499-1503`);
    - pull the rest with the scope log's `join(heads, {timeout})`
      (`@peerbit/shared-log index.d.ts:1124-1131`). A fetched entry whose
      document id or kind differs from what R resolved is a lie.

    When the batch returns, pick the next one from what is still in D.
    Peerbit's own pushes keep arriving in parallel and shrink D. The prototype
    pulled 512 of 6,030 entries; the rest arrived by push first. There is no
    stall timer.

8. A head still not indexed after a pull is classified:
    - explained (section 4.6): removed from D;
    - trust-pending (its signer is not yet trusted, and the trust scopes are
      not all contained yet): parked; re-classified on the next trust-graph
      change, whenever any peer's `TRUST_V1` scope becomes contained, and
      whenever C changes;
    - otherwise `fetch-failed`. `join` returns `Promise<void>` with no per-hash
      result, so J cannot tell "nobody can serve it" from a timeout, a busy
      donor or the U-34 stall. After the first failure J opens one fresh
      session with R, because R may have retired the row (case 15). If the
      fresh snapshot still lists and resolves the head, R stays `reconciling`
      and the pull is retried on R's next sign of life (any message, a
      `replication:change`), on any index change, and when another batch
      finishes. A fetch failure never excludes R. A head nobody ever serves
      keeps J gated, which is a denial, not a wrong ready; status names it
      (`waiting-fetch`).
9. `unsubstantiated` needs a provable lie: R left out of its own `ResolvedV1`
   an element it listed, resolved a row of a kind outside the scope, or
   resolved a head whose fetched entry has a different document id or kind.
10. When D is empty, R is contained at t_R. J records
    `{peer, openNonce, scope, count, missingAtStart, pulled, explained}`.

### 4.6 Explained rows

| Case                                                                                                                   | Explained?                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| J's log of that scope holds an entry whose `meta.next` includes this exact head: a CUT, or a later put of the document | Yes, `superseded`. R lists a row J has already seen replaced or deleted                                                                              |
| `canPerform` rejected the entry for structure (bad fields, sealed name)                                                | Yes, `rejected-structure`                                                                                                                            |
| Rejected because the signer is untrusted, and J contains the trust scope of every peer in C                            | Provisionally, `rejected-untrusted`. Re-checked on every trust-graph change and whenever C grows; the head goes back into D if its signer is trusted |
| Rejected because the signer is untrusted, while some trust scope is not yet contained                                  | No, `trust-pending` (section 4.5 step 8)                                                                                                             |
| Rejected by the 1 s negative trust cache (`src/index.ts:2111`)                                                         | No, `trust-pending`                                                                                                                                  |

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

The lookup runs only for heads still in D after a resolve, at most 256 per
batch. M0 P2 confirms that it finds the CUT of a head J never held, in both
logs, after a reopen. One case stays unexplained: J holds the CUT of a later
version d but not d itself, and R still lists the older head h. Nothing in J
names h, so J pulls h, and Peerbit's index does with it what it would do if R
had pushed h. P2 records which; K0 has the follow-up if h is logged but never
indexed.

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
| `reconciling`               | listing, decoding, draining, pulling, or waiting to retry a failed pull                                | yes                                            | D empty, a provable lie                                                                                              |
| `silent`                    | a connected or live peer missed all three attempts                                                     | **yes**                                        | any message from R (a late `HeaderV1` included), a replication announcement or subscribe from R, operator, R leaving |
| `contained`                 | done; records whether R qualified in that session's header                                             | no                                             | final for this open                                                                                                  |
| `left`                      | R unsubscribed or became unreachable after J held its `HeaderV1`                                       | no                                             | R reappears (new session)                                                                                            |
| `left-unanswered`           | R left before J held its `HeaderV1`                                                                    | yes, until its attempt in flight ends (if any) | R reappears (new session); the attempt ends with R still gone (then `gaps`, D4)                                      |
| `unconfirmed`               | visible only through a replication row, no sign of life since J opened, and did not answer one attempt | no (not Required)                              | any sign of life from R (then it is live and asked again with full attempts)                                         |
| `excluded(inconsistent)`    | count/digest mismatch twice, or an oversize answer                                                     | no                                             | sticky for this open                                                                                                 |
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
  stale row of a dead peer after an unclean leave. M0 P1 checks that such a
  row produces no replication event at a fresh joiner.
- **Leaving before answering.** Pubsub emits `unsubscribe` on a peer session
  reset as well as on unreachability (`@peerbit/pubsub index.js:3328-3351`),
  so a reconnect flap looks like a departure. A peer that leaves before J
  holds its `HeaderV1` is `left-unanswered` and keeps blocking until its
  attempt in flight ends. If it comes back, it gets a new session. If it stays
  away, J records `gaps: {peer, missing: "unknown"}` and status shows it (D4).
  So a timer can end a block only for a peer pubsub has already reported gone.
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

| Event                                                                              | Effect                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| open finished                                                                      | list visible peers, start sessions                                                         |
| pubsub `subscribe` / `unsubscribe` on the readiness topic                          | add the peer / mark it `left` or `left-unanswered`                                         |
| `replicator:join`, `replication:change`, `replicator:leave` (`index.d.ts:471-473`) | add the peer; a sign of life makes it live (full attempts); leave as above                 |
| any readiness message from R                                                       | advance that session; moves `silent` and `busy` back to `asking`; retries R's failed pulls |
| index `change` (added rows)                                                        | drain D, O(1) per row per live session; retries failed pulls                               |
| trust graph `change`                                                               | retry `trust-pending`; re-check `rejected-untrusted`; re-check qualification               |
| a peer's `TRUST_V1` scope becomes contained, or C changes                          | re-classify `trust-pending` and `rejected-untrusted` heads                                 |
| another session of J completes                                                     | re-ask each `busy` peer once                                                               |
| bootstrap decision or phase change (the #403 hook)                                 | `evaluate()`                                                                               |
| attempt timeout                                                                    | next attempt or `silent`; ends `left-unanswered` for a peer still gone                     |
| pull batch finished                                                                | start the next batch; retry failed pulls                                                   |

Timers that remain. None makes J ready on its own:

| Timer                  | Value                     | Bounds                                                                                  |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| request attempt        | 5 s, then 10 s, then 20 s | one attempt; then the peer is `silent` and still blocks; ends a `left-unanswered` block |
| pull `join` timeout    | 10 s                      | one batch; a failed pull waits for a trigger                                            |
| responder session idle | 30 s                      | R's memory                                                                              |

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
                "count": 804
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
- The proof is for audit, status and telemetry. Nothing re-reads it to decide.
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

### 4.12 Edge cases

| #   | Case                                                                    | Outcome                                                                                                                       |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plain dial, idle donor                                                  | Ready after transfer plus about 3 round trips                                                                                 |
| 2   | Donor writes every 1 s                                                  | Ready; the snapshot does not move. 0.66 s measured                                                                            |
| 3   | Genesis-only creator                                                    | `count: 0`, contained, qualified. One round trip                                                                              |
| 4   | Busy creator plus a stale warm replica                                  | Gated until the creator answers, even after its attempts end (`silent` blocks; the late answer counts); then contained        |
| 5   | Truncated list, or `done` forged early                                  | `incomplete`, then `inconsistent`                                                                                             |
| 6   | Remote iterate false-empty (U-5/U-6)                                    | Not used. Empty is an explicit `count: 0`                                                                                     |
| 7   | Stable-id re-put with new bytes                                         | A new entry hash, so it is required                                                                                           |
| 8   | Under-reporting peer                                                    | Looks like a lagging donor; other Required peers still bind J                                                                 |
| 9   | Over-reporting peer (phantom elements)                                  | Unresolvable element: `unsubstantiated`. A resolved head nobody serves: R stays `reconciling`, J stays gated (a denial)       |
| 10  | Two fresh joiners, donor gone                                           | Contain each other, neither qualifies, both gated                                                                             |
| 11  | Two fresh joiners, donor present                                        | First to finish becomes ready and notifies; the other opens a fresh session with it, which can qualify it                     |
| 12  | Donor leaves after answering, J contained it                            | Still ready                                                                                                                   |
| 13  | Donor leaves mid-pull, nobody else has its rows                         | `gaps` recorded, R stops blocking (D4)                                                                                        |
| 14  | Dead peer still in `getReplicators()` after an unclean leave            | No sign of life since open: asked once, `unconfirmed`. Subscriber: blocks until pubsub drops it (M0 probe P1)                 |
| 15  | Donor retires a row between snapshot and pull                           | One fresh session; the new snapshot lacks it                                                                                  |
| 16  | J holds the CUT of a head R still lists                                 | `superseded`; not pulled                                                                                                      |
| 17  | Writer revoked during the join                                          | Its rows are provisionally `rejected-untrusted` once every trust scope is contained                                           |
| 18  | Trust graph lagging                                                     | `trust-pending`; gated until the edge arrives (correct)                                                                       |
| 19  | Only partial replicas or observers visible                              | Gated                                                                                                                         |
| 20  | Late donor pushes (`@peerbit/shared-log index.js:517-538`, `7608-7610`) | Irrelevant; J compares against the snapshot and pulls                                                                         |
| 21  | 100k files, one difference                                              | RIBLT, 1-2 batches; R freezes in about 20-30 ms at 200k rows once seeded (the seed costs about 1.6 s once per open, estimate) |
| 22  | 20 joiners against one donor                                            | `BUSY` beyond the caps; directed notices and completed sessions re-ask; bounded                                               |
| 23  | Lost Subscribe and no other traffic; only the genesis creator visible   | Wrong ready possible (non-guarantee)                                                                                          |
| 24  | U-34 post-heal 10 s handshake stall                                     | Latency only; a late answer counts and a failed pull is retried, never excluded                                               |
| 25  | Clock skew                                                              | No effect; no wall clock enters the proof                                                                                     |
| 26  | Crash before the proof is persisted                                     | Gated again, sessions rerun; superseded heads are found in J's log again                                                      |
| 27  | Long GC history (20k CUTs)                                              | No readiness state grows with it; `superseded` is a log lookup and rejections are bounded by in-flight batches                |
| 28  | Peer on another format                                                  | Different address; not visible                                                                                                |
| 29  | Element collision                                                       | Salt per responder open; accidental chance about 1e-9 at 200k rows; a grinder can hide only its own rows                      |
| 30  | `allowPartialWrites` session                                            | No gating; coordinator may run for telemetry; Guard D stays disarmed                                                          |
| 31  | Busy creator whose readiness Subscribe was lost (U-1)                   | Live through its replication traffic; blocks like case 4                                                                      |
| 32  | Unanswered peer's connection resets and redials                         | `left-unanswered` until its attempt ends; a new session when it is back                                                       |
| 33  | GC CUT recovery, Guard D resurrection, or trust re-grant during a join  | The re-put head is a new entry with no child in J: required and pulled                                                        |
| 34  | Trust grant after J's trust snapshot of R                               | Impossible within one session (trust frozen after namespace); across peers, `rejected-untrusted` is re-checked as C grows     |
| 35  | Entry committed to J's log, index write not done yet                    | Stays in D until its index change event                                                                                       |
| 36  | Notice from a peer J contained while that peer was gated                | Starts a fresh session; qualifies only through that session's header                                                          |

## 5. Trust and adversarial analysis

| Actor                   | Who                                                       | Can forge rows? | What it can do to readiness                                                     | Defence                                                                                                      |
| ----------------------- | --------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Trusted writer          | keys in the rooted trust graph (`src/index.ts:4255-4268`) | it is trusted   | write rows only some peers have                                                 | containment of every Required peer; frontier layer later (M4)                                                |
| Writer in open mode     | anyone (`src/index.ts:4227-4229`)                         | n/a             | same                                                                            | same; no writer set exists                                                                                   |
| Answering peer          | anyone holding the address; self-announced                | no              | under-report (looks like lagging), over-report, stall, claim to be qualified    | contain everyone; provable lies exclude; silence blocks; late answers count; trusted identity when ACL is on |
| Relay                   | anyone on the path                                        | no              | drop, delay                                                                     | signed messages, count and digest checks; latency only                                                       |
| Sybil peers (open mode) | many self-announced peers                                 | no              | each must be contained; can slow J; cannot make J ready without a qualified one | in open mode a Sybil can claim `qualified`; documented (D7)                                                  |

Specific attacks:

- **Truncation.** Count plus sha256 over the sorted list. A shortened or
  reordered list fails. RIBLT results are checked the same way after decode.
- **Phantom elements.** An element R leaves out of its own resolve answer, or
  a fetched entry that does not match what R resolved, makes R
  `unsubstantiated`. A head R resolves but nobody serves cannot be told apart
  from a slow honest donor (`join` reports no per-hash result), so it keeps J
  gated instead of excluding R. R cannot make J pull junk: pulled entries pass
  the normal `canPerform` checks.
- **Grinding collisions.** The salt is drawn at R's open, after earlier rows
  exist. A grinder that learns it can make two of its own entries collide and
  hide one of them, which withholding already allows. Hiding another writer's
  row needs a 64-bit second preimage (D15).
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
  revocation.
- **What stays open.** A writer whose rows sit only on peers J cannot see. A
  frontier layer (M4) narrows this for trusted writers, if frontiers spread
  wider than the data, for example through always-on witnesses.

## 6. Cost and latency budget

### 6.1 Measured

In-process prototype of sections 4.4-4.5, in-process calls instead of RPC,
round trips counted (`evidence/upstream-sync/reconcile-run2.out`). A real remote
count query round trip measured 6-14 ms (primitives map B5). "Today" is the current
`awaitWriteReady` in the same run.

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
(`evidence/semantic-safety/results.ndjson`); `@peerbit/riblt` d=10 decodes in
13 symbols, d=1000 in 1,449 (`evidence/primitives/riblt-bench.out`); a salted
sha256 to 64 bits costs 2.5 µs per row (same file).

The prototype did not salt elements, did not use the digest (it used XOR),
resolved through an in-memory map, and its joiner held no rows
(`joinerRows: 0` in every first session), so it measured neither side's
salting nor the joiner's own scan. Salting adds about 2.5 µs per row on each
side on first contact with a peer. M1 must re-measure.

### 6.2 Cost

| Item                   | Value                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per change while ready | zero until a peer asks; then one salted hash and one set update per row change per scope (about 3-5 µs, estimate)                                                                          |
| Per change while gated | one salted hash per live peer salt per added row (about 2.5 µs)                                                                                                                            |
| Donor seed             | one projected scan per scope per open, on the first request: measured about 8 µs/row; about 1.6 s CPU at 200k rows (estimate)                                                              |
| Donor snapshot         | copy and sort of the visible elements, about 20-30 ms at 200k rows (estimate); shared by every session at the same epoch                                                                   |
| Donor memory           | maintained set about 56 B/row in typed arrays: about 11-15 MB at 200k (estimate), once per responder; plus 1.6 MB per live snapshot; 64 MB cap per responder, `BUSY` above it (M0 P4)      |
| Wire, J close to R     | header plus 32 symbols, about 0.8 KB; about 1.45·d symbols × 24 B for d differences; capped at list-mode parity                                                                            |
| Wire, J far from R     | 8 B per donor row (about 1.6 MB at 200k) plus about 100-120 B per resolved row it pulls (elem 8, head 34-49, docId about 52, kind, length prefixes)                                        |
| Joiner                 | one projected scan of its own index per open (4-6 µs/row, shared by all peers) plus one salted hash per own row per peer salt: about 0.8-1.2 s plus 0.5 s per peer at 200k rows (estimate) |
| Storage                | sidecar proof, at most 96 peer records; no index column                                                                                                                                    |
| Code (estimate)        | +900-1,100 product lines, +1,100 test lines, about −300 lines (tracker, evidence capture, idle read; discovery's route reads stay until M2)                                                |
| Format                 | one salt bump and one program field                                                                                                                                                        |

### 6.3 Expected latency after M1 (cross-process, estimates)

| Case                                    | Today                          | M1                                                                                                                                               | M2            |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Plain dial, small store                 | 5.34 s measured                | 0.3-0.6 s                                                                                                                                        | same          |
| Both peers `bootstrap()`, genesis donor | about 5.7 s measured           | about 5.3-5.7 s (discovery deadline dominates)                                                                                                   | under 1 s     |
| Donor writing every 1 s                 | never                          | under 2 s                                                                                                                                        | same          |
| 3k-file cold join                       | 12.9-14.9 s in-process         | 7.9-9.7 s in-process; transfer dominates                                                                                                         | same          |
| 200k-row cold join                      | transfer + 5 s, may be partial | transfer + R's seed (about 1.6 s, once per R open) + one list (1.6 MB) + residual pulls                                                          | same          |
| Rejoin after a partition, small diff    | transfer + 5 s                 | 2 round trips per peer plus the diff; at 200k rows J spends about 0.8-1.2 s scanning plus 0.5 s per peer, R about 30 ms per snapshot once seeded | same          |
| Unverified bootstrap posture            | at least 10 min                | at least 10 min                                                                                                                                  | ends on proof |

## 7. API, telemetry and mount behaviour

| Surface             | Change                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrapStatus()` | `writeReadinessSource`: `creator` \| `reconciled` \| `operator`. New `readiness: {state, required, contained[], excluded[], silent[], inFlight[], fetchPending[], gaps[]}`. `msSinceLastArrival` is removed.                                                                                          |
| `readiness.state`   | `no-peer`, `no-qualified-donor`, `reconciling`, `waiting-silent`, `waiting-fetch`, `waiting-left`, `waiting-trust`, `waiting-phase`, `ready`                                                                                                                                                          |
| `awaitWriteReady`   | Same contract (`src/index.ts:12495-12570`). `ETIMEDOUT` carries the `readiness` snapshot, so callers can say why.                                                                                                                                                                                     |
| `assumeComplete()`  | New. Persists `operator`, arms Guard D, resolves waiters. Refused on observers and partial replicas.                                                                                                                                                                                                  |
| Open options        | `writeReadiness?: {requestTimeoutMs = 5000, requireFreshOnReopen = false}` (the second is M2). The internal `writeReadinessSettleMs` is removed.                                                                                                                                                      |
| Events              | `write:ready` for every source, creator included. New `readiness:progress` (peer state changes). M2: `freshness:change`.                                                                                                                                                                              |
| Telemetry           | `readiness-session{peer, scope, mode, count, missingAtStart, pulled, explained, roundTrips, ms}`, `readiness-peer{peer, state, reason}`, `write-ready{source, contained, excluded, gaps, ms}`, `writers-unheard{count}` (ACL stores: trusted writers with no row seen). Removed: `synchronizer-idle`. |
| Mount backend       | Unchanged: `EAGAIN` for writable opens and namespace mutations while gated (`mount-backend.ts:142-150`, `939-948`).                                                                                                                                                                                   |
| CLI `mount`         | Waits as today (`--write-ready-timeout-ms`, default 120000). Prints one progress line ("reconciling with 2 peers, 1 contained, 1 silent: <peer>"). On timeout prints the reason. New `--assume-complete`.                                                                                             |
| README              | Replace "settled-view heuristic" and "Nothing is lost" with sections 2.2 and 2.3.                                                                                                                                                                                                                     |

## 8. Test plan

All tests are deterministic and in-process unless marked. Fault injection uses
test-only hooks on the readiness responder (drop, delay, truncate, lie, `BUSY`,
suppress the readiness Subscribe), on block serving, on the index write after
a log commit, and on `canPerform`. A shared helper with a fake clock asserts
that no timer is armed while J is gated with nothing in flight. Every session
in the suite also runs a shadow check: R's maintained set equals a fresh scan
under the same salt.

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

| #   | Test                                                                                                                       | Pass when                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 15  | Busy live creator (answers after 6 s) plus a stale warm replica (answers in 20 ms)                                         | not ready until the creator is contained                                                                   |
| 16  | Same, with the creator's readiness Subscribe suppressed                                                                    | not ready until the creator is contained                                                                   |
| 17  | Same, with the creator answering after 40 s (after all attempts)                                                           | ready only after the late answer, without the caller retrying                                              |
| 18  | Connected subscriber that never answers                                                                                    | gated; `ETIMEDOUT` names it; ready after it unsubscribes                                                   |
| 19  | Unanswered peer's pubsub session resets and it redials                                                                     | stays Required; a new session; not ready without it unless it stays away (then `gaps`)                     |
| 20  | `BUSY` whose notice is lost                                                                                                | re-asked when another session completes or on R's next message                                             |
| 21  | Dead replicator row with no sign of life since open                                                                        | asked once, `unconfirmed`, does not block                                                                  |
| 22  | Truncated list; forged early `done`; wrong digest                                                                          | never ready on that answer                                                                                 |
| 23  | Under-report with a second honest peer                                                                                     | gated until the honest peer is contained                                                                   |
| 24  | Under-report as the only peer                                                                                              | ready; the proof names the peer (pins the non-guarantee)                                                   |
| 25  | Over-claim: unresolvable element; resolved row of the wrong kind or document id                                            | `unsubstantiated`; with no other qualified donor, gated                                                    |
| 26  | Honest donor whose block serving is delayed past two pull timeouts                                                         | never excluded; ready once the blocks are served                                                           |
| 27  | Head resolved but never served by anyone                                                                                   | gated, `waiting-fetch` names the peer; never excluded                                                      |
| 28  | RIBLT session with zero symbols                                                                                            | cannot complete                                                                                            |
| 29  | RIBLT with equal counts and a symmetric difference of 2k                                                                   | switches to list mode within the parity budget; correct result                                             |
| 30  | Forced element collision through a hook, then a reopened responder (new salt)                                              | the next snapshot finds the row                                                                            |
| 31  | Replayed or foreign `sessionId`, wrong log id for the scope, notice with a stale `openNonce`                               | ignored                                                                                                    |
| 32  | Only gated peers; only partial replicas                                                                                    | gated; `state: no-qualified-donor`                                                                         |
| 33  | No peer visible; fake clock advanced by hours                                                                              | never ready; a later peer makes it ready by event                                                          |
| 34  | Trust lag: a row whose trust edge arrives later                                                                            | gated until the edge, then ready                                                                           |
| 35  | Revoked writer's rows                                                                                                      | explained once all trust scopes are contained; ready                                                       |
| 36  | Grant and write land at R between J's trust and namespace views; a second peer holding the grant joins C after a rejection | trust is frozen after namespace; `rejected-untrusted` is re-checked; ready only with the edge and the rows |
| 37  | `trust-pending` head whose last trust session completes with an empty D                                                    | re-classified without a trust-graph change; no hang                                                        |
| 38  | Cross-process ACL store; the joiner lacks one trust edge                                                                   | `TRUST_V1` pulls from `trustGraph.log`; ready with the edge                                                |
| 39  | Donor lists a head whose CUT J holds                                                                                       | `superseded`; not pulled; no resurrection                                                                  |
| 40  | GC CUT plus recovery re-put during a join                                                                                  | the re-put head is required and pulled                                                                     |
| 41  | Guard D resurrection with the stale delete already admitted at J                                                           | the re-put head is required                                                                                |
| 42  | Revoke then re-grant of a writer during a join                                                                             | the re-grant is required; the writer's rows are held                                                       |
| 43  | Donor with 20k CUTs (slow lane)                                                                                            | a fresh joiner becomes ready; no readiness state grows with the CUT count                                  |
| 44  | Index write delayed after the log commit (hook)                                                                            | not ready until the index has the row                                                                      |
| 45  | Donor departs mid-pull with rows nobody else has                                                                           | `gaps` recorded; behaviour per D4                                                                          |
| 46  | `BUSY` storm: 20 joiners, one donor                                                                                        | all ready; the donor never exceeds its caps                                                                |
| 47  | `assumeComplete()` with no peers                                                                                           | ready with source `operator`; refused on an observer                                                       |

**Cross-process** (the `quiet-window` harness): n = 20 for plain dial, both
`bootstrap()`, and donor writing every 1 s. Report p50 and p95.

**Mount** (hosted smokes, #387): a fresh mount returns `EAGAIN` until ready and
then accepts `git clone` with no naming conflicts.

## 9. Milestones and kill points

| Milestone                                      | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Exit                                                                                                                                                                                          | Kill point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** Probes (private copy, about 3 days)     | P1: how long pubsub keeps a subscriber after an unclean leave, and whether a dead peer's stale replication row produces any replication event at a fresh joiner. P2: (a) `log.entryIndex.getHasNext` finds the CUT of a head J never held, in the entries log and the trust log, after a reopen; (b) what Documents indexes when J pulls an older head whose later version's CUT J holds. P3: whether trust revocation always reaches a joiner as a delete (`@peerbit/trusted-network controller.js:248-255`). P4: donor seed time, maintained-set memory and per-change cost, and freeze time at 50k and 200k rows; sets the memory cap. P5: the prototype over one-way RPC messages, cross-process. P6: whether put paths can carry `meta.data` tags. File U-36. | results recorded under `readiness-design-20261004/m0/`                                                                                                                                        | **K0:** if P1 shows dead subscribers linger over 60 s, `silent` still blocks until pubsub's peer-unreachable `unsubscribe` (`@peerbit/pubsub index.js:3334-3351`), never on elapsed attempts; the linger is latency, and U-37 is filed. If P1 shows they are never dropped, D3 goes back to the owner with option B and its wrong ready. If P2(a) fails, keep a CUT-target index (entry hash → CUT) from the change tap and one log scan at open, bounded by the log, not by a cap. If P2(b) shows the older head is logged but never indexed, J also fetches the CUT's target and explains the head when that target descends from it. |
| **M1** Proof-based readiness (no upstream)     | Salt `/shared-fs/v9.2` and the RPC field; one-way messages; responder with the maintained element set (salt per open); sessions (list and RIBLT with the parity cap, salted, digest-checked); coordinator; peer states including live and `left-unanswered`; the `superseded` lookup and the bounded rejection record; `TRUST_V1` on `trustGraph.log`; `ChangesetManifest` in `NAMESPACE_V1`; directed `StateNoticeV1` as a trigger only; `assumeComplete`; sidecar proof and parser allowlist; telemetry; CLI line. Remove the quiet window, the poll, the double check, the evidence flag, the `syncronizer.pending` read and the fence's route read. Gate scheduled GC on readiness. Guard D never armed by the override. Tests 1-47.                           | cross-process plain dial p50 ≤ 0.6 s and p95 ≤ 1.5 s (n = 20); continuous writer ≤ 2 s; test 13 green n ≥ 3; suite green 3 times; no timer armed while idle-gated; shadow check never differs | **K1:** p95 > 1.5 s, flakes > 1 in 200, or a soundness hole in review: ship containment as an extra prerequisite of today's tracker (strictly safer than today, no faster) and diagnose before going further. **K2:** if the shadow check ever finds the maintained set differs from a fresh scan, or per-change upkeep exceeds 20 µs at 200k rows, build each snapshot by a scan instead (about 1.6 s CPU at 200k rows), keeping the per-open salt.                                                                                                                                                                                    |
| **M2** Reach                                   | Warm freshness: fetch without joining, explained by superseding entries in J's log; `warm-fresh`; only `warm-fresh` qualifies (D6); opt-in `requireFreshOnReopen`. Bootstrap decision on a complete qualified answer (both `bootstrap()` under 1 s). `unverified` posture ends on proof. Bootstrap discovery moves off the private `pubsub` reads.                                                                                                                                                                                                                                                                                                                                                                                                                 | both-bootstrap p95 < 1 s; freshness at rest ≤ 1 request per peer per minute in a 10-peer soak                                                                                                 | If freshness load is too high, make it on-demand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **M3** Adopt U-36 (when released in a cohort)  | Capability-selected transport behind one `ReconcileTransport` seam; shadow test comparing entry-hash sets; delete the interim session messages; keep a small provenance attestation RPC; ride the next salt bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | shadow sets equal on all tests; latency not worse than M1                                                                                                                                     | **K3:** if U-36 lacks metadata scoping and whole-log scope makes ready more than 20% slower on a store with large files, keep the interim for namespace scope and use U-36 for trust only.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **M4** Optional: signed frontiers (ACL stores) | Per-stream (author key, random stream id) frontiers that commit to entry hashes, signed and bound to the store id, ordered by seq; carried in answers and by witnesses; default policy `available`, never `strict`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | closes the stale-donor test when a witness holds the frontier; frontier bytes < 2% of write bytes                                                                                             | if frontier traffic > 5% of write bytes, or `writers-unheard` stays at zero in practice, drop it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **M5** Optional: per-operation readiness       | Owned writes never wait; foreign writes prove their footprint over the same RPC; built only on top of the M1 global proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | first foreign write about 0.2 s after open at 6k files (measured with a stand-in)                                                                                                             | if footprint coverage cannot be made exhaustive by a table-driven test, drop it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

M1 depends on no unreleased upstream work. It uses only public surfaces of the
5.4.10 cohort: `@peerbit/rpc` 6.2.4 (`send` with `to`), `@peerbit/riblt`
1.2.0, the projected index iterate with `__context.head`,
`SharedLog.join(hashes)`, `Log.has`, `log.entryIndex.getHasNext`,
`getReplicators`, replicator and pubsub events, the trust graph's own
`Documents` log, and `getTrusted()`.

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
event. Optional part (b): scoping by `meta.data` prefix. Full semantics and
done-when tests: `evidence/design-upstream-sync.md` §3. This closes U-7.

**U-37 (only if K0 fires): a public peer reachability signal.** A documented
way to learn that a peer is reachable now, and an `unsubscribe` within a stated
bound after an unclean leave. Today the fence and discovery read
`pubsub.routes` privately (`src/index.ts:10200-10246`).

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

## 12. Owner decisions needed

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
10. **D10. Upstream.** File the merged U-36 now; file U-37 only if K0 fires;
    hold U-38 for M4. _Recommendation: yes._
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
15. **D15. Salt per responder open, not per snapshot.** It allows the
    maintained element set (no per-session re-hash or scan) at the price of a
    small in-memory upkeep per change once a peer has asked. A grinder can then
    hide only its own rows, which it could withhold anyway. _Recommendation:
    accept._
16. **D16. `ChangesetManifest` in the namespace scope.** Ready then also covers
    every changeset turn a contained peer held, so `changesetStatus` agrees
    with readiness. The alternative is to state in section 2.3 that changeset
    completeness is not covered. _Recommendation: include._

## Appendix: evidence

- `~/git/shared-fs-evidence/unblocked-20261003/quiet-window/`: today's 5.34 s
  breakdown, the donor-confirmed prototype and its patch.
- `evidence/map-current-contract.md`, `map-primitives.md`,
  `map-correctness-model.md`: the three maps this design builds on.
- `evidence/design-upstream-sync.md`, `design-digest-visible.md`,
  `design-semantic-safety.md`, `design-signed-frontiers.md`: the candidates.
- `evidence/upstream-sync/reconcile-run2.out`, `riblt-empty.out`: section 6.1
  and the zero-symbol guard.
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
