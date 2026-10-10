import { deserialize } from "@dao-xyz/borsh";
import type { PublicSignKey } from "@peerbit/crypto";
import { isPutOperation } from "@peerbit/document";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import {
    SharedFileSystem,
    SharedFsHandle,
    SharedFsWriteReadyTimeoutError,
    openSharedFs,
} from "../index.js";
import { FileVersion, NamingEvent, SharedFsEntry } from "../model.js";
import { BLOCKING_STATES, Coordinator } from "../readiness/coordinator.js";
import { headDigest } from "../readiness/digest.js";
import { hlcProvedOf, validateProof } from "../readiness/proof.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import { NAMESPACE_V1, SCOPE_NAMESPACE_V1 } from "../readiness/scopes.js";
import type { SessionResult } from "../readiness/session.js";
import { documentsIndexPort } from "../readiness/tap.js";
import {
    HeaderV1,
    NOTICE_REASON,
    OpenV1,
    StateNoticeV1,
    type ReadinessMessage,
} from "../readiness/wire.js";
import { holdFlips } from "./readiness-flip-hold.js";
import { watchTimers } from "./readiness-timer-watch.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The joiner's design tests on in-process Peerbit peers and real
 * filesystems (M1 plan 7.3, SPEC2 7.3, SPEC4 9.4(1); WRITE_READINESS_V2.md
 * section 8): tests 1 to 8 (8 also with J1's notice arriving while J2's
 * session with it runs), 10, 14, 16 and 44, plus the per-session K2 row.
 *
 * Since PR-3 commit 4 the coordinator's predicate (design 4.8, phase clause
 * included) decides when a fresh full address-open turns ready:
 * `markWriteReady` reads it and its proof at one synchronous point,
 * persists the proof and flips, with no quiet window and no timer. These
 * tests check J's maintained set inside the `write:ready` dispatch (the
 * flip, not some time after it) and read containment from
 * `bootstrapStatus().readiness`, the coordinator's records and its proof. A
 * flip can now land before `openSharedFs` returns, so a capture at the flip
 * of an unheld join is installed before the open (`atReadyOn`). Where a
 * test needs J satisfied but not yet flipped (what a long quiet window gave
 * before), it parks J's decision (`holdFlips`) and releases it.
 *
 * Fault injection stays in the test: a donor's responder holds OPENs by a
 * monkeypatch of its own runtime's `responder.onMessage`; test 16
 * suppresses a Subscribe with the readiness transport's `hideSubscriber`
 * hook and starts J's coordinator after J's log exchanged replication info
 * (the usual order, fixed), then again in whatever order the run takes;
 * tests 6 and 44 hold J's index write of a change
 * its log already committed (`holdIndexWrites`, which names the wrapped
 * method).
 */

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime | undefined =>
    (fs.program as any).readinessRuntime;
const programOf = (fs: SharedFsHandle): any => fs.program;
const entriesOf = (fs: SharedFsHandle): any => programOf(fs).entries;
const hashOf = (peer: Peerbit) => peer.identity.publicKey.hashcode();
const readinessOf = (fs: SharedFsHandle) => fs.bootstrapStatus().readiness;

const coordinatorOf = (fs: SharedFsHandle): Coordinator => {
    const coordinator = runtimeOf(fs)?.coordinator;
    if (!coordinator) throw new Error("no coordinator runs for this open");
    return coordinator;
};

/** The namespace result of the session that contained `peer`, if any. */
const resultOf = (
    fs: SharedFsHandle,
    peer: Peerbit
): SessionResult | undefined =>
    coordinatorOf(fs).record(hashOf(peer))?.results.get(SCOPE_NAMESPACE_V1);

const waitUntil = async (
    assertion: () => Promise<void> | void,
    timeoutMs = process.env.CI ? 60_000 : 30_000
) => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw lastError;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `awaitWriteReady` with `timeout`, which must time out. */
const timeoutOf = async (fs: SharedFsHandle, timeout: number) => {
    const error = await fs.awaitWriteReady({ timeout }).then(
        () => {
            throw new Error("awaitWriteReady resolved");
        },
        (error: unknown) => error
    );
    expect(error).toBeInstanceOf(SharedFsWriteReadyTimeoutError);
    return error as SharedFsWriteReadyTimeoutError;
};

/**
 * The namespace rows of `fs`'s index (id to head), read through the tap's
 * own index port, so the ids are the ones containment compares.
 */
const namespaceRows = async (fs: SharedFsHandle) => {
    const port = documentsIndexPort(entriesOf(fs), NAMESPACE_V1);
    const rows = new Map<string, string>();
    for await (const page of port.scan()) {
        for (const row of page) rows.set(row.key as string, row.head);
    }
    return rows;
};

/** The namespace rows of `fs`'s index with their `__context.modified`. */
const namespaceRowsWithModified = async (fs: SharedFsHandle) => {
    const port = documentsIndexPort(entriesOf(fs), NAMESPACE_V1);
    const rows = new Map<string, { head: string; modified: bigint }>();
    for await (const page of port.scan()) {
        for (const { key, head, modified } of page) {
            rows.set(key as string, { head, modified });
        }
    }
    return rows;
};

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/**
 * The ids of `rows` whose head `fs`'s namespace tap does not hold, read
 * synchronously. The tap adds a head only from the index's change event,
 * so a head it holds is one J's index held.
 */
const missingFromTap = (
    fs: SharedFsHandle,
    rows: ReadonlyMap<string, string>
): string[] => {
    const tap = runtimeOf(fs)?.namespace;
    if (!tap) return [...rows.keys()];
    const missing: string[] = [];
    for (const [key, head] of rows) {
        const slot = tap.map.get(key);
        if (!(slot >= 0 && tap.map.headEquals(slot, headDigest(head)))) {
            missing.push(key);
        }
    }
    return missing;
};

/** The ids of `rows` whose head `fs`'s index does not hold now. */
const missingFromIndex = async (
    fs: SharedFsHandle,
    rows: ReadonlyMap<string, string>
) => {
    const held = await namespaceRows(fs);
    return [...rows.keys()].filter((key) => held.get(key) !== rows.get(key));
};

/**
 * Runs `capture` inside `fs`'s `write:ready` dispatch: the flip is visible
 * and nothing else has run since the decision's sidecar write. For a join
 * something holds (a busy donor, a parked decision); one already flipped
 * fails at once instead of waiting for a dispatch that never comes.
 */
const atReady = <T>(fs: SharedFsHandle, capture: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
        if (fs.bootstrapStatus().writeReady) {
            reject(new Error("J flipped before the capture was installed"));
            return;
        }
        programOf(fs).events.addEventListener(
            "write:ready",
            () => {
                try {
                    resolve(capture());
                } catch (error) {
                    reject(error);
                }
            },
            { once: true }
        );
    });

/**
 * Holds every OPEN `donor`'s responder receives (a busy peer that holds the
 * store and stays reachable) until `release`, which delivers them in order.
 */
const holdOpens = (donor: SharedFsHandle) => {
    const responder = runtimeOf(donor)!.responder!;
    const onMessage = responder.onMessage;
    const held: Array<[ReadinessMessage, PublicSignKey | undefined]> = [];
    let holding = true;
    responder.onMessage = (message, from) => {
        if (holding && message instanceof OpenV1) {
            held.push([message, from]);
            return;
        }
        onMessage.call(responder, message, from);
    };
    return {
        get held() {
            return held.length;
        },
        release: () => {
            if (!holding) return;
            holding = false;
            responder.onMessage = onMessage;
            for (const [message, from] of held.splice(0)) {
                onMessage.call(responder, message, from);
            }
        },
    };
};

/** A promise and its resolve. */
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
};

/** The object on `target`'s prototype chain that defines `name`. */
const ownerOf = (target: object, name: string): any => {
    for (let owner: any = target; owner; owner = Object.getPrototypeOf(owner)) {
        if (Object.hasOwn(owner, name)) return owner;
    }
    throw new Error(`no ${name} on the prototype chain`);
};

/** `promise`, or a rejection naming `what` after `ms`. */
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
    Promise.race([
        promise,
        sleep(ms).then(() => {
            throw new Error(`${what} within ${ms} ms`);
        }),
    ]);

/** The shared-fs rows a log change adds, decoded, with their heads. */
const rowsOf = async (change: any) => {
    const rows: Array<{ head: string; value: SharedFsEntry }> = [];
    for (const { entry } of change?.added ?? []) {
        try {
            const payload = await entry.getPayloadValue();
            if (!isPutOperation(payload)) continue;
            rows.push({
                head: entry.hash,
                value: deserialize(payload.data, SharedFsEntry),
            });
        } catch {
            // Not a shared-fs row.
        }
    }
    return rows;
};

/**
 * Holds J's index write of every log change that adds a row `match`es,
 * after the log committed it, until `release` (design 8: "the index write
 * after a log commit"). The wrapped method is `Documents.handleChangesInOrder`
 * (`@peerbit/document` 15.1.11, `dist/src/program.js:3725`): the log's
 * `onChange` (`program.js:1452`, `3715-3723`) hands it each committed change,
 * and it writes the index rows (`DocumentIndex.put`/`putWithContext`,
 * `program.js:3853`, `search.js:1980-1999`) and dispatches the change event.
 * The hold sits before its first index access. Inside `putWithContext` it
 * would sit in an ordered write session that holds SQLite's admission
 * barrier (`@peerbit/indexer-sqlite3 dist/src/engine.js:599-640`) whenever an
 * earlier row of the change was written, and stall every read of J's
 * database, the readiness reads included. `store` is the donor's store,
 * whose own changes are never held.
 */
const holdIndexWrites = (
    store: object,
    match: (value: SharedFsEntry, head: string) => boolean
) => {
    const owner = ownerOf(store, "handleChangesInOrder");
    const handleChangesInOrder = owner.handleChangesInOrder;
    const gate = deferred();
    const reached = deferred();
    const held: Array<{ head: string; value: SharedFsEntry }> = [];
    let released = false;
    owner.handleChangesInOrder = async function (
        this: unknown,
        change: unknown,
        ...rest: unknown[]
    ) {
        if (this !== store && !released) {
            const matched = (await rowsOf(change)).filter(({ value, head }) =>
                match(value, head)
            );
            if (matched.length > 0) {
                held.push(...matched);
                reached.resolve();
                await gate.promise;
            }
        }
        return handleChangesInOrder.call(this, change, ...rest);
    };
    const release = () => {
        released = true;
        gate.resolve();
    };
    return {
        held,
        reached: reached.promise,
        release,
        restore: () => {
            release();
            owner.handleChangesInOrder = handleChangesInOrder;
        },
    };
};

const shadowCounts = () => ({
    ...globalThis.__SFS_READINESS_SHADOW__!.counts,
});

describe("readiness join (in-process)", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    /** Undone first in afterEach: held gates, patched prototypes, hooks. */
    const restores: Array<() => void> = [];

    afterEach(async () => {
        for (const restore of restores.splice(0).reverse()) {
            try {
                restore();
            } catch {
                // Best effort; the peers stop next either way.
            }
        }
        delete globalThis.__SFS_READINESS_TRANSPORT_HOOKS__;
        await stopTestPeers(peers);
        for (const root of roots.splice(0)) {
            await rm(root, { recursive: true, force: true });
        }
    });

    type Node = { peer: Peerbit; fs: SharedFsHandle };

    const createPeer = async (
        options: { directory?: string; connectionGater?: object } = {}
    ) => {
        const peer = await Peerbit.create({
            ...(options.directory ? { directory: options.directory } : {}),
            ...(options.connectionGater
                ? { libp2p: { connectionGater: options.connectionGater } }
                : {}),
        } as any);
        peers.push(peer);
        return peer;
    };

    /**
     * A peer that refuses connections to and from the peers in `refused`
     * once they are added (a partition, as in multi-peer.test.ts).
     */
    const partitionablePeer = async () => {
        const refused = new Set<string>();
        const deny = (peerId: unknown) => refused.has(String(peerId));
        const peer = await createPeer({
            connectionGater: {
                denyDialPeer: deny,
                denyOutboundConnection: deny,
                denyInboundEncryptedConnection: deny,
                denyOutboundEncryptedConnection: deny,
                denyInboundUpgradedConnection: deny,
                denyOutboundUpgradedConnection: deny,
            },
        });
        return { peer, refused };
    };

    const stopPeer = async (peer: Peerbit) => {
        const index = peers.indexOf(peer);
        if (index >= 0) peers.splice(index, 1);
        await peer.stop();
    };

    const newRoot = async () => {
        const root = await mkdtemp(joinPath(tmpdir(), "shared-fs-join-"));
        roots.push(root);
        return root;
    };

    const files = (count: number, prefix = "/tree") =>
        Array.from({ length: count }, (_, i) => ({
            path: `${prefix}/d${i % 10}/f${i}.txt`,
            content: `content ${i}`,
        }));

    /** A creator with `count` files (none: a genesis-only creator). */
    const createDonor = async (
        count: number,
        label = "join-donor",
        peer?: Peerbit
    ): Promise<Node> => {
        peer ??= await createPeer();
        const fs = await openSharedFs({
            peerbit: peer,
            machineLabel: label,
            gc: false,
        });
        if (count > 0) await fs.writeBatch(files(count));
        return { peer, fs };
    };

    /**
     * A fresh full address-open of `donors[0]`'s filesystem, dialed to each
     * donor; `bootstrap` defaults to a plain join.
     */
    const joinOf = async (
        donors: Node[],
        options: {
            bootstrap?: false | "auto";
            label?: string;
            peer?: Peerbit;
        } = {}
    ): Promise<Node> => {
        const peer = options.peer ?? (await createPeer());
        for (const donor of donors) await peer.dial(donor.peer);
        const fs = await openSharedFs({
            peerbit: peer,
            address: donors[0].fs.address,
            machineLabel: options.label ?? "join-joiner",
            bootstrap: options.bootstrap ?? false,
            gc: false,
        });
        return { peer, fs };
    };

    /**
     * Runs `capture` inside the `write:ready` dispatch of the first flip of
     * a filesystem opened on `peer` from now on, given that filesystem. The
     * hook is installed before the open, as such a flip can land before
     * `openSharedFs` returns.
     */
    const atReadyOn = <T>(
        peer: Peerbit,
        capture: (fs: SharedFsHandle) => T
    ): Promise<T> => {
        const prototype = SharedFileSystem.prototype as any;
        const commitWriteReady = prototype.commitWriteReady;
        let installed = true;
        const uninstall = () => {
            if (!installed) return;
            installed = false;
            prototype.commitWriteReady = commitWriteReady;
        };
        restores.push(uninstall);
        return new Promise((resolve, reject) => {
            prototype.commitWriteReady = function (
                this: any,
                ...args: unknown[]
            ) {
                if (this.node === peer) {
                    uninstall();
                    this.events.addEventListener(
                        "write:ready",
                        () => {
                            try {
                                resolve(capture(new SharedFsHandle(this)));
                            } catch (error) {
                                reject(error);
                            }
                        },
                        { once: true }
                    );
                }
                return commitWriteReady.apply(this, args);
            };
        });
    };

    /** A full replica of `donor` that joined it and turned ready (reconciled). */
    const readyReplica = async (
        donor: Node,
        label = "join-replica",
        peer?: Peerbit
    ) => {
        const replica = await joinOf([donor], { label, peer });
        await replica.fs.awaitWriteReady({ timeout: 60_000 });
        expect(programOf(replica.fs).readinessProvenance()).toMatchObject({
            writeReady: true,
            source: "reconciled",
        });
        return replica;
    };

    /**
     * Parks the decisions of every filesystem opened on `peer` until
     * `release()` (`holdFlips`); undone in afterEach.
     */
    const holdFlipsOf = (peer: Peerbit) => {
        const hold = holdFlips(peer);
        restores.push(hold.restore);
        return hold;
    };

    /**
     * K2 row: `sessions` contained sessions ran the per-session shadow check
     * on J and on R (C1 G18; both run in this process) and none differed.
     */
    const expectSessionChecks = async (
        before: ReturnType<typeof shadowCounts>,
        sessions: number
    ) => {
        await waitUntil(() =>
            expect(shadowCounts().sessionChecks).toBeGreaterThanOrEqual(
                before.sessionChecks + 2 * sessions
            )
        );
        // A difference also fails the test from the setup's afterEach.
        expect(shadowCounts().failed).toBe(before.failed);
    };

    describe("1: plain dial", () => {
        it.each([1, 400, 3_000])(
            "%i files: ready, J's index holds every donor row at the flip, the donor is named qualified",
            async (count) => {
                const donor = await createDonor(count);
                const rows = await namespaceRows(donor.fs);
                // A naming event and a version per file, plus directories.
                expect(rows.size).toBeGreaterThanOrEqual(2 * count);
                const before = shadowCounts();
                const peer = await createPeer();
                const flip = atReadyOn(peer, (fs) => missingFromTap(fs, rows));
                const joiner = await joinOf([donor], { peer });
                await joiner.fs.awaitWriteReady({ timeout: 110_000 });
                expect(await flip).toEqual([]);
                expect(await missingFromIndex(joiner.fs, rows)).toEqual([]);

                const donorHash = hashOf(donor.peer);
                const status = readinessOf(joiner.fs)!;
                expect(status).toMatchObject({
                    state: "ready",
                    satisfied: true,
                    required: [],
                    excluded: [],
                    gaps: [],
                });
                expect(status.contained).toEqual([
                    {
                        peer: donorHash,
                        qualified: true,
                        source: "creator",
                        scopes: ["namespace-v1"],
                        departed: false,
                    },
                ]);
                expect(resultOf(joiner.fs, donor.peer)).toMatchObject({
                    count: rows.size,
                    qualified: true,
                });
                expect(coordinatorOf(joiner.fs).proof()).toMatchObject({
                    scopes: ["namespace-v1"],
                    contained: [
                        {
                            peer: donorHash,
                            scope: "namespace-v1",
                            source: "creator",
                            qualified: true,
                            count: rows.size,
                        },
                    ],
                    excluded: [],
                    gaps: [],
                });
                await expectSessionChecks(before, 1);
            },
            180_000
        );
    });

    it("2: a genesis-only creator is contained by one answer with count 0", async () => {
        const creator = await createDonor(0, "join-genesis");
        expect((await namespaceRows(creator.fs)).size).toBe(0);
        const joiner = await joinOf([creator]);
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });

        expect(resultOf(joiner.fs, creator.peer)).toMatchObject({
            mode: "empty",
            count: 0,
            roundTrips: 1,
            pulled: 0,
            qualified: true,
            source: "creator",
        });
        expect(readinessOf(joiner.fs)).toMatchObject({
            state: "ready",
            satisfied: true,
            contained: [
                {
                    peer: hashOf(creator.peer),
                    qualified: true,
                    source: "creator",
                },
            ],
        });
        expect(coordinatorOf(joiner.fs).proof().contained).toEqual([
            expect.objectContaining({
                peer: hashOf(creator.peer),
                count: 0,
                qualified: true,
            }),
        ]);
    });

    it("3: a donor writing every 100 ms turns J ready within 2 s of its open, on the donor's snapshot (no chase)", async () => {
        // Design test 3, the starvation regression of the quiet window. It
        // is timing-sensitive: a failure is rerun alone before it is
        // triaged, and it counts in the flake budget (SPEC4 9.4(1)).
        const donor = await createDonor(10);
        // One new file every 100 ms, from before J opens until after it
        // turned ready. New paths only, so the donor's rows only grow, and
        // its clock orders every row written after a snapshot above that
        // snapshot's `hlc`.
        let writing = true;
        let written = 0;
        let writerError: unknown;
        const writer = (async () => {
            while (writing) {
                const started = Date.now();
                await donor.fs.writeFile(
                    `/tree/d0/live-${written}.txt`,
                    `write ${written}`
                );
                written++;
                await sleep(Math.max(0, 100 - (Date.now() - started)));
            }
        })().catch((error) => (writerError = error));
        restores.push(() => (writing = false));
        await waitUntil(() => expect(written).toBeGreaterThanOrEqual(5));
        const peer = await createPeer();
        await peer.dial(donor.peer);
        const writtenAtOpen = written;
        const opened = performance.now();
        const flip = atReadyOn(peer, (fs) => {
            // J's maintained set at the flip: every head, and how many
            // rows lie above the contained snapshot's `hlc`.
            const result = resultOf(fs, donor.peer)!;
            const held = new Set<string>();
            let above = 0;
            runtimeOf(fs)!.namespace!.map.forEach((digest, modified) => {
                held.add(hexOf(digest));
                if (modified > result.hlc) above++;
            });
            return {
                ms: performance.now() - opened,
                written,
                result,
                held,
                above,
            };
        });
        const joiner = await joinOf([donor], { peer });
        await joiner.fs.awaitWriteReady({ timeout: 30_000 });
        const atFlip = await flip;
        // Two more writes, so rows above the snapshot exist whenever its
        // freeze came.
        await waitUntil(() =>
            expect(written).toBeGreaterThanOrEqual(atFlip.written + 2)
        );
        writing = false;
        await writer;
        expect(writerError).toBeUndefined();
        const { result } = atFlip;
        console.info(
            `readiness-join 3: ready ${atFlip.ms.toFixed(0)} ms after the open; ${atFlip.written - writtenAtOpen} writes meanwhile; snapshot count ${result.count}, mode ${result.mode}, x ${result.x}, J's rows above the snapshot at the flip ${atFlip.above}`
        );
        expect(atFlip.ms).toBeLessThan(2_000);
        // The writer never paused for J.
        expect(atFlip.written).toBeGreaterThan(writtenAtOpen);
        expect(result).toMatchObject({ qualified: true, source: "creator" });
        // The contained snapshot is exactly the donor's rows at or below
        // its `hlc`, and J's index held every one of them at the flip.
        const rows = await namespaceRowsWithModified(donor.fs);
        const snapshot = [...rows].filter(
            ([, row]) => row.modified <= result.hlc
        );
        expect(snapshot.length).toBe(result.count);
        expect(
            snapshot
                .filter(
                    ([, row]) => !atFlip.held.has(hexOf(headDigest(row.head)))
                )
                .map(([key]) => key)
        ).toEqual([]);
        // The snapshot did not chase the writer: it is a prefix of the
        // donor's rows (rows above its `hlc` exist and are not counted),
        // and the ones J held at the certificate were subtracted as X
        // (J's rows only grow).
        expect(
            [...rows.values()].filter(({ modified }) => modified > result.hlc)
                .length
        ).toBeGreaterThan(0);
        expect(result.x).toBeLessThanOrEqual(atFlip.above);
    }, 120_000);

    describe("4: a donor that leaves", () => {
        it("after containment stays contained and never blocks: J's flip, held until the donor left, makes J ready with the departed donor as its qualified containment", async () => {
            const donor = await createDonor(5);
            const peer = await createPeer();
            // J's decision waits for the test: J is contained and
            // satisfied, not flipped, when the donor leaves.
            const hold = holdFlipsOf(peer);
            const joiner = await joinOf([donor], { peer });
            const donorHash = hashOf(donor.peer);
            await waitUntil(() => {
                expect(hold.parked()).toBe(1);
                expect(readinessOf(joiner.fs)).toMatchObject({
                    state: "reconciling",
                    satisfied: true,
                    required: [],
                    contained: [{ peer: donorHash, qualified: true }],
                });
            });

            await stopPeer(donor.peer);
            const coordinator = coordinatorOf(joiner.fs);
            await waitUntil(() =>
                expect(coordinator.record(donorHash)?.departed).toBe(true)
            );
            expect(coordinator.record(donorHash)).toMatchObject({
                state: "contained",
                qualified: true,
            });
            expect(coordinator.satisfied()).toBe(true);
            expect(readinessOf(joiner.fs)).toMatchObject({
                state: "reconciling",
                satisfied: true,
                required: [],
                gaps: [],
                contained: [
                    { peer: donorHash, qualified: true, departed: true },
                ],
            });
            expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
            // No live replicator is left: what held J before commit 4.
            await waitUntil(async () =>
                expect(
                    await programOf(joiner.fs).liveRemoteReplicators()
                ).toEqual([])
            );

            // Design 4.12 #12: still ready.
            const flip = atReady(joiner.fs, () => ({
                status: readinessOf(joiner.fs)!,
                proof: coordinator.proof(),
            }));
            hold.release();
            await joiner.fs.awaitWriteReady({ timeout: 30_000 });
            const atFlip = await flip;
            expect(atFlip.status).toMatchObject({
                state: "ready",
                required: [],
                excluded: [],
                gaps: [],
                contained: [
                    {
                        peer: donorHash,
                        qualified: true,
                        source: "creator",
                        departed: true,
                    },
                ],
            });
            expect(atFlip.proof).toMatchObject({
                contained: [
                    { peer: donorHash, qualified: true, source: "creator" },
                ],
                gaps: [],
            });
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
                guardArmed: true,
            });
            await joiner.fs.writeFile("/after-donor.txt", "writable");
        });

        it("after containment, with another qualified donor live, lets J turn ready", async () => {
            const donor = await createDonor(5);
            const replica = await readyReplica(donor);
            const peer = await createPeer();
            const hold = holdFlipsOf(peer);
            const joiner = await joinOf([donor, replica], { peer });
            const donorHash = hashOf(donor.peer);
            const replicaHash = hashOf(replica.peer);
            await waitUntil(() => {
                const status = readinessOf(joiner.fs)!;
                expect(status.satisfied).toBe(true);
                expect(status.contained.map(({ peer }) => peer).sort()).toEqual(
                    [donorHash, replicaHash].sort()
                );
                expect(hold.parked()).toBe(1);
            });

            await stopPeer(donor.peer);
            const coordinator = coordinatorOf(joiner.fs);
            await waitUntil(() =>
                expect(coordinator.record(donorHash)?.departed).toBe(true)
            );
            expect(coordinator.satisfied()).toBe(true);

            const flip = atReady(joiner.fs, () => readinessOf(joiner.fs));
            hold.release();
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            const atFlip = (await flip)!;
            expect(atFlip.state).toBe("ready");
            // The donor that left is still a containment, not a gap.
            expect(atFlip.gaps).toEqual([]);
            expect(atFlip.contained).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        peer: donorHash,
                        qualified: true,
                        source: "creator",
                        departed: true,
                    }),
                    expect.objectContaining({
                        peer: replicaHash,
                        qualified: true,
                        source: "reconciled",
                        departed: false,
                    }),
                ])
            );
        });

        it("after J turned ready leaves J ready", async () => {
            const donor = await createDonor(5);
            const joiner = await joinOf([donor]);
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            expect(coordinatorOf(joiner.fs).phase).toBe("finished");

            await stopPeer(donor.peer);
            await waitUntil(async () =>
                expect(
                    await programOf(joiner.fs).liveRemoteReplicators()
                ).toEqual([])
            );
            expect(joiner.fs.bootstrapStatus()).toMatchObject({
                writeReady: true,
                writeReadinessSource: "reconciled",
                guardArmed: true,
            });
            expect(readinessOf(joiner.fs)).toMatchObject({
                state: "ready",
                contained: [{ peer: hashOf(donor.peer), qualified: true }],
            });
            await joiner.fs.awaitWriteReady({ timeout: 1_000 });
            await joiner.fs.writeFile("/after-donor.txt", "still writable");
        });
    });

    it("5: two donors with disjoint extra rows: satisfied only once both are contained", async () => {
        const firstPeer = await partitionablePeer();
        const secondPeer = await partitionablePeer();
        const first = await createDonor(4, "join-first", firstPeer.peer);
        const second = await readyReplica(
            first,
            "join-second",
            secondPeer.peer
        );
        // Partition the donors. A block put announces its provider to the
        // dialed bootstraps and would dial the other donor again
        // (multi-peer.test.ts), so neither announces to any, and neither
        // accepts the other.
        for (const node of [first, second]) {
            node.peer.services.fanout.setBootstraps([]);
        }
        firstPeer.refused.add(second.peer.peerId.toString());
        secondPeer.refused.add(first.peer.peerId.toString());
        await second.peer.hangUp(first.peer.identity.publicKey);
        await first.peer.hangUp(second.peer.identity.publicKey);
        await waitUntil(() => {
            expect(
                first.peer.libp2p.getConnections(second.peer.peerId)
            ).toHaveLength(0);
            expect(
                second.peer.libp2p.getConnections(first.peer.peerId)
            ).toHaveLength(0);
        });
        await first.fs.writeBatch(files(6, "/first"));
        await second.fs.writeBatch(files(6, "/second"));
        const firstRows = await namespaceRows(first.fs);
        const secondRows = await namespaceRows(second.fs);
        const onlyFirst = [...firstRows.keys()].filter(
            (key) => !secondRows.has(key)
        );
        const onlySecond = [...secondRows.keys()].filter(
            (key) => !firstRows.has(key)
        );
        expect(onlyFirst.length).toBeGreaterThanOrEqual(12);
        expect(onlySecond.length).toBeGreaterThanOrEqual(12);
        const union = new Map([...firstRows, ...secondRows]);

        const busy = holdOpens(second.fs);
        restores.push(busy.release);
        const before = shadowCounts();
        const joiner = await joinOf([first, second]);
        const firstHash = hashOf(first.peer);
        const secondHash = hashOf(second.peer);
        const coordinator = coordinatorOf(joiner.fs);
        await waitUntil(() => {
            expect(resultOf(joiner.fs, first.peer)?.qualified).toBe(true);
            expect(busy.held).toBeGreaterThan(0);
        });
        // The second donor's extras may have arrived by sync already; its
        // containment has not.
        expect(BLOCKING_STATES.has(coordinator.record(secondHash)!.state)).toBe(
            true
        );
        expect(coordinator.satisfied()).toBe(false);
        const error = await timeoutOf(joiner.fs, 1_500);
        expect(error.readiness).toMatchObject({
            satisfied: false,
            required: [secondHash],
            contained: [{ peer: firstHash, qualified: true }],
        });
        expect(error.readiness!.inFlight.map(({ peer }) => peer)).toEqual([
            secondHash,
        ]);

        const flip = atReady(joiner.fs, () => missingFromTap(joiner.fs, union));
        busy.release();
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(await flip).toEqual([]);
        expect(readinessOf(joiner.fs)!.contained).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ peer: firstHash, qualified: true }),
                expect.objectContaining({
                    peer: secondHash,
                    qualified: true,
                    source: "reconciled",
                }),
            ])
        );
        await expectSessionChecks(before, 2);
    });

    it("6: a stable-id re-put with new bytes on the donor during the join is required by its entry hash", async () => {
        const donor = await createDonor(0);
        await donor.fs.writeFile("/stable.txt", "stable");
        const donorRows = await namespaceRows(donor.fs);
        const [versionId] = [...donorRows.keys()].filter((key) =>
            key.startsWith("version:")
        );
        const oldHead = donorRows.get(versionId)!;
        const donorEntries = entriesOf(donor.fs);

        // J's index write of the re-put waits for the test, so J's index
        // holds the same id at the old head meanwhile.
        const writes = holdIndexWrites(
            donorEntries,
            (value, head) =>
                value instanceof FileVersion &&
                value.id === versionId &&
                head !== oldHead
        );
        restores.push(writes.restore);

        const busy = holdOpens(donor.fs);
        restores.push(busy.release);
        const joiner = await joinOf([donor]);
        const joinerEntries = entriesOf(joiner.fs);
        await waitUntil(() =>
            expect(
                missingFromTap(joiner.fs, new Map([[versionId, oldHead]]))
            ).toEqual([])
        );

        // The donor re-puts the same id with new bytes: a new entry.
        const entry = await donorEntries.log.log.get(oldHead);
        const value = deserialize(
            (await entry.getPayloadValue()).data,
            SharedFsEntry
        ) as FileVersion;
        value.machineLabel = "join-donor re-put";
        const reput = await donorEntries.put(value);
        const newHead: string = reput.entry.hash;
        expect(newHead).not.toBe(oldHead);
        const reputRows = await namespaceRows(donor.fs);
        expect(reputRows.get(versionId)).toBe(newHead);
        // Same ids, same count: only the entry hash tells the rows apart.
        expect(reputRows.size).toBe(donorRows.size);
        await within(writes.reached, 30_000, "J logged no re-put");
        expect(writes.held.map(({ head }) => head)).toEqual([newHead]);
        expect(await joinerEntries.log.log.has(newHead)).toBe(true);

        busy.release();
        const coordinator = coordinatorOf(joiner.fs);
        const donorHash = hashOf(donor.peer);
        await waitUntil(() => {
            const session = coordinator.record(donorHash)?.session;
            expect(
                session?.debug().scopes[SCOPE_NAMESPACE_V1]?.logged ?? 0
            ).toBeGreaterThan(0);
        });
        // J holds the id, at the old head: that is not R's row.
        expect(
            missingFromTap(joiner.fs, new Map([[versionId, oldHead]]))
        ).toEqual([]);
        expect(coordinator.satisfied()).toBe(false);
        const error = await timeoutOf(joiner.fs, 1_500);
        expect(error.readiness).toMatchObject({
            satisfied: false,
            required: [donorHash],
            contained: [],
        });

        const flip = atReady(joiner.fs, () =>
            missingFromTap(joiner.fs, reputRows)
        );
        writes.release();
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(await flip).toEqual([]);
        expect((await namespaceRows(joiner.fs)).get(versionId)).toBe(newHead);
        expect(resultOf(joiner.fs, donor.peer)).toMatchObject({
            qualified: true,
            count: reputRows.size,
        });
    });

    it("7: an identical populated store without a proof is ready after one answer (fast)", async () => {
        const donor = await createDonor(30);
        const rows = await namespaceRows(donor.fs);
        const directory = joinPath(await newRoot(), "joiner");
        const first = await joinOf([donor], {
            peer: await createPeer({ directory }),
        });
        await first.fs.awaitWriteReady({ timeout: 60_000 });
        await stopPeer(first.peer);

        // The copy keeps every row; its sidecar loses the proof, so the
        // next full open there is a fresh join.
        const stateDirectory = joinPath(directory, "shared-fs-bootstrap");
        const [stateName] = await readdir(stateDirectory);
        const statePath = joinPath(stateDirectory, stateName);
        await writeFile(statePath, JSON.stringify({ writeReady: false }));
        const joiner = await joinOf([donor], {
            peer: await createPeer({ directory }),
            label: "join-copy",
        });
        expect(await missingFromIndex(joiner.fs, rows)).toEqual([]);
        await joiner.fs.awaitWriteReady({ timeout: 30_000 });

        const donorHash = hashOf(donor.peer);
        expect(resultOf(joiner.fs, donor.peer)).toMatchObject({
            mode: "fast",
            count: rows.size,
            roundTrips: 1,
            missingAtStart: 0,
            pulled: 0,
            cells: 0,
            qualified: true,
            source: "creator",
        });
        expect(coordinatorOf(joiner.fs).record(donorHash)!.sessionsOpened).toBe(
            1
        );
        expect(readinessOf(joiner.fs)).toMatchObject({
            state: "ready",
            satisfied: true,
            required: [],
            contained: [{ peer: donorHash, qualified: true }],
        });
        expect(joiner.fs.bootstrapStatus()).toMatchObject({
            writeReady: true,
            writeReadinessSource: "reconciled",
            guardArmed: true,
        });
        // The decision persisted its proof: the one answer, contained.
        const sidecar = JSON.parse(await readFile(statePath, "utf8"));
        expect(sidecar).toMatchObject({
            writeReady: true,
            writeReadySource: "reconciled",
        });
        const proof = validateProof(sidecar.proof);
        expect(proof.ok).toBe(true);
        if (!proof.ok) return;
        expect(proof.proof.contained).toEqual([
            expect.objectContaining({
                peer: donorHash,
                scope: "namespace-v1",
                qualified: true,
                count: rows.size,
            }),
        ]);
        expect(sidecar.hlcProved).toBe(String(hlcProvedOf(proof.proof)));
    });

    it("8: J2 waits for a fresh session with J1 after J1's READY notice; the notice alone never qualifies", async () => {
        const donor = await createDonor(5);
        const donorHash = hashOf(donor.peer);
        // J1's decision waits for the test: J1 contains the donor and stays
        // gated while it leaves and J2 joins.
        const firstPeer = await createPeer();
        const firstHold = holdFlipsOf(firstPeer);
        const first = await joinOf([donor], {
            label: "join-j1",
            peer: firstPeer,
        });
        await waitUntil(() => {
            expect(readinessOf(first.fs)).toMatchObject({
                satisfied: true,
                contained: [{ peer: donorHash, qualified: true }],
            });
            expect(firstHold.parked()).toBe(1);
        });
        // The donor closes before J2 contains it: J2 never sees it.
        await stopPeer(donor.peer);
        await waitUntil(() =>
            expect(coordinatorOf(first.fs).record(donorHash)?.departed).toBe(
                true
            )
        );

        const second = await joinOf([first], { label: "join-j2" });
        const firstHash = hashOf(first.peer);
        const coordinator = coordinatorOf(second.fs);
        // What J2's coordinator holds right after J1's READY notice ran.
        const atNotice: Array<{
            satisfied: boolean;
            state?: string;
            qualified?: boolean;
            qualifying?: boolean;
        }> = [];
        const runtime = runtimeOf(second.fs)!;
        const onMessage = runtime.onMessage;
        runtime.onMessage = (message, from, bytes) => {
            onMessage.call(runtime, message, from, bytes);
            if (
                message instanceof StateNoticeV1 &&
                message.reason === NOTICE_REASON.READY &&
                from?.hashcode() === firstHash
            ) {
                const record = coordinator.record(firstHash);
                atNotice.push({
                    satisfied: coordinator.satisfied(),
                    state: record?.state,
                    qualified: record?.qualified,
                    qualifying: record?.qualifying,
                });
            }
        };
        restores.push(() => (runtime.onMessage = onMessage));

        await waitUntil(() =>
            expect(readinessOf(second.fs)).toMatchObject({
                state: "no-qualified-donor",
                satisfied: false,
                required: [],
                contained: [
                    { peer: firstHash, qualified: false, source: "none" },
                ],
            })
        );
        const error = await timeoutOf(second.fs, 1_500);
        expect(error.readiness).toMatchObject({ state: "no-qualified-donor" });
        // A live replicator never released anything since commit 4, and
        // J1 is one: J2's predicate alone holds J2 (S23).
        await waitUntil(async () =>
            expect(await programOf(second.fs).liveRemoteReplicators()).toEqual([
                firstHash,
            ])
        );
        expect(runtimeOf(second.fs)!.satisfied()).toBe(false);
        expect(second.fs.bootstrapStatus().writeReady).toBe(false);

        // J1 turns ready (the donor it contained left; J2 is its live
        // replicator) and sends J2 a READY notice.
        firstHold.release();
        await first.fs.awaitWriteReady({ timeout: 60_000 });
        expect(programOf(first.fs).readinessProvenance()).toMatchObject({
            writeReady: true,
            source: "reconciled",
        });
        await second.fs.awaitWriteReady({ timeout: 60_000 });

        expect(atNotice.length).toBeGreaterThan(0);
        expect(atNotice[0]).toEqual({
            satisfied: false,
            state: "contained",
            qualified: false,
            qualifying: true,
        });
        const record = coordinator.record(firstHash)!;
        expect(record.qualified).toBe(true);
        expect(record.sessionsOpened).toBeGreaterThanOrEqual(2);
        expect(readinessOf(second.fs)).toMatchObject({
            state: "ready",
            contained: [
                { peer: firstHash, qualified: true, source: "reconciled" },
            ],
        });
    });

    it("8 (in flight): J1's READY notice while J2 still waits for J1's gated header opens a fresh session once J2 contains J1", async () => {
        const donor = await createDonor(5);
        const donorHash = hashOf(donor.peer);
        // J1's decision waits for the test: J1 contains the donor and stays
        // gated while it leaves and J2 joins.
        const firstPeer = await createPeer();
        const firstHold = holdFlipsOf(firstPeer);
        const first = await joinOf([donor], {
            label: "join-j1",
            peer: firstPeer,
        });
        await waitUntil(() => {
            expect(readinessOf(first.fs)).toMatchObject({
                satisfied: true,
                contained: [{ peer: donorHash, qualified: true }],
            });
            expect(firstHold.parked()).toBe(1);
        });
        await stopPeer(donor.peer);
        await waitUntil(() =>
            expect(coordinatorOf(first.fs).record(donorHash)?.departed).toBe(
                true
            )
        );

        // J1's headers wait at J1's send until the test lets them go (a
        // slow answer); its notices pass.
        const responder: any = runtimeOf(first.fs)!.responder!;
        const send = responder.ports.send;
        const held: Array<() => Promise<void>> = [];
        let holding = true;
        responder.ports.send = (message: ReadinessMessage, to: unknown) => {
            if (holding && message instanceof HeaderV1) {
                held.push(() => send.call(responder.ports, message, to));
                return Promise.resolve();
            }
            return send.call(responder.ports, message, to);
        };
        restores.push(() => (responder.ports.send = send));

        const second = await joinOf([first], { label: "join-j2" });
        const firstHash = hashOf(first.peer);
        await waitUntil(() => expect(held.length).toBeGreaterThan(0));
        const coordinator = coordinatorOf(second.fs);
        // J2's record of J1 when J1's READY notice ran.
        const atNotice: Array<string | undefined> = [];
        const runtime = runtimeOf(second.fs)!;
        const onMessage = runtime.onMessage;
        runtime.onMessage = (message, from, bytes) => {
            onMessage.call(runtime, message, from, bytes);
            if (
                message instanceof StateNoticeV1 &&
                message.reason === NOTICE_REASON.READY &&
                from?.hashcode() === firstHash
            ) {
                atNotice.push(coordinator.record(firstHash)?.state);
            }
        };
        restores.push(() => (runtime.onMessage = onMessage));

        // J1 turns ready (J2 is its live replicator, and J2 answers it).
        firstHold.release();
        await first.fs.awaitWriteReady({ timeout: 60_000 });
        expect(programOf(first.fs).readinessProvenance()).toMatchObject({
            writeReady: true,
            source: "reconciled",
        });
        await waitUntil(() => expect(atNotice.length).toBeGreaterThan(0));
        expect(atNotice[0]).toBe("asking");

        // J1's header, frozen while J1 was gated, reaches J2 now.
        holding = false;
        for (const deliver of held.splice(0)) await deliver();
        await second.fs.awaitWriteReady({ timeout: 30_000 });
        const record = coordinator.record(firstHash)!;
        expect(record.qualified).toBe(true);
        expect(record.sessionsOpened).toBeGreaterThanOrEqual(2);
        expect(readinessOf(second.fs)).toMatchObject({
            state: "ready",
            contained: [
                { peer: firstHash, qualified: true, source: "reconciled" },
            ],
        });
    });

    describe("10: the bootstrap snapshot path", () => {
        /** A donor whose snapshot holds its tree. */
        const snapshotDonor = async () => {
            const donor = await createDonor(60);
            const snapshot = await donor.fs.snapshotWrite();
            expect(snapshot.segments).toBeGreaterThan(0);
            return donor;
        };

        it("is waiting-phase while the overlay is active, with the predicate unsatisfied; the retirement alone makes J ready (M8)", async () => {
            const donor = await snapshotDonor();
            const rows = await namespaceRows(donor.fs);
            const donorHash = hashOf(donor.peer);
            const peer = await createPeer();
            // Hold the verified retirement of J's overlay (its last step
            // before `converged`) until the test lets it run.
            const owner = ownerOf(donor.fs.program, "retireOverlay");
            const retireOverlay = owner.retireOverlay;
            const retirements: Array<() => void> = [];
            owner.retireOverlay = function (this: any, ...args: unknown[]) {
                if (this.node === peer && args[0] === true) {
                    retirements.push(() => retireOverlay.apply(this, args));
                    return;
                }
                return retireOverlay.apply(this, args);
            };
            restores.push(() => (owner.retireOverlay = retireOverlay));
            const joiner = await joinOf([donor], { peer, bootstrap: "auto" });
            const coordinator = coordinatorOf(joiner.fs);
            // Every peer is accounted for; only the phase clause, now
            // inside the predicate (G4-5), holds J.
            await waitUntil(() => {
                expect(retirements.length).toBeGreaterThan(0);
                expect(readinessOf(joiner.fs)).toMatchObject({
                    state: "waiting-phase",
                    satisfied: false,
                    required: [],
                    contained: [{ peer: donorHash, qualified: true }],
                });
            });
            expect(joiner.fs.bootstrapStatus().phase).toBe("overlay-active");
            expect(runtimeOf(joiner.fs)!.satisfied()).toBe(false);
            const error = await timeoutOf(joiner.fs, 1_500);
            expect(error.readiness).toMatchObject({
                state: "waiting-phase",
                satisfied: false,
            });
            // Nothing was asked to decide, and nothing is armed.
            expect(coordinator.debug().decisions).toMatchObject({
                started: 0,
                inFlight: false,
            });
            expect(runtimeOf(joiner.fs)!.debug().armedTimers).toBe(0);

            // The phase change itself schedules the evaluation (M8).
            const program = programOf(joiner.fs);
            const setBootstrapPhase = program.setBootstrapPhase;
            const converged: Array<{ before: boolean; after: boolean }> = [];
            program.setBootstrapPhase = function (this: any, phase: string) {
                const before = coordinator.debug().evaluationPending;
                setBootstrapPhase.call(this, phase);
                if (phase === "converged") {
                    converged.push({
                        before,
                        after: coordinator.debug().evaluationPending,
                    });
                }
            };
            restores.push(() => delete program.setBootstrapPhase);
            const timers = watchTimers();
            restores.push(timers.stop);
            const flip = atReady(joiner.fs, () => {
                timers.stop();
                return {
                    phase: joiner.fs.bootstrapStatus().phase,
                    missing: missingFromTap(joiner.fs, rows),
                    decisions: coordinator.debug().decisions,
                };
            });
            owner.retireOverlay = retireOverlay;
            for (const retire of retirements.splice(0)) retire();
            await joiner.fs.awaitWriteReady({ timeout: 30_000 });
            expect(await flip).toEqual({
                phase: "converged",
                missing: [],
                decisions: { started: 1, failed: 0, inFlight: true },
            });
            expect(converged).toHaveLength(1);
            expect(converged[0].after).toBe(true);
            // Between waiting-phase and the flip the decision armed no
            // timer of its own (no quiet window, no poll).
            expect(timers.readiness).toEqual([]);
            expect(readinessOf(joiner.fs)).toMatchObject({
                state: "ready",
                contained: [{ peer: donorHash, qualified: true }],
            });
        });

        it("waits for containment after the overlay converged", async () => {
            const donor = await snapshotDonor();
            const rows = await namespaceRows(donor.fs);
            const busy = holdOpens(donor.fs);
            restores.push(busy.release);
            const joiner = await joinOf([donor], { bootstrap: "auto" });
            await waitUntil(() =>
                expect(joiner.fs.bootstrapStatus().phase).toBe("converged")
            );
            await waitUntil(() => expect(busy.held).toBeGreaterThan(0));
            const donorHash = hashOf(donor.peer);
            const error = await timeoutOf(joiner.fs, 1_500);
            expect(error.readiness).toMatchObject({
                state: "reconciling",
                satisfied: false,
                required: [donorHash],
            });
            expect(error.readiness!.inFlight.map(({ peer }) => peer)).toEqual([
                donorHash,
            ]);
            // The phase clause holds and the donor is a live replicator:
            // the donor's containment alone holds J.
            const program = programOf(joiner.fs);
            expect(program.writeReadinessDecisionSettled).toBe(true);
            expect(program.readinessPhaseSettled()).toBe(true);
            expect(await program.liveRemoteReplicators()).toEqual([donorHash]);
            expect(runtimeOf(joiner.fs)!.satisfied()).toBe(false);

            const flip = atReady(joiner.fs, () =>
                missingFromTap(joiner.fs, rows)
            );
            busy.release();
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            expect(await flip).toEqual([]);
            expect(readinessOf(joiner.fs)).toMatchObject({
                state: "ready",
                contained: [{ peer: donorHash, qualified: true }],
            });
        });
    });

    it.each([
        ["plain", false as const],
        ["snapshot", "auto" as const],
    ])(
        "14: changesetStatus is complete right after ready for a turn the donor held (%s join)",
        async (_name, bootstrap) => {
            const donor = await createDonor(10);
            const turn = await donor.fs.writeBatch(files(40, "/turn"), {
                changesetId: "turn-14",
                manifest: true,
            });
            const members = turn.manifest!.memberCount;
            expect(members).toBeGreaterThan(40);
            if (bootstrap) await donor.fs.snapshotWrite();

            const peer = await createPeer();
            const status = atReadyOn(peer, (fs) =>
                fs.changesetStatus("turn-14")
            );
            const joiner = await joinOf([donor], { bootstrap, peer });
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            expect(await await status).toMatchObject({
                known: true,
                complete: true,
                verdict: "complete",
                expected: members,
                arrived: members,
            });
        }
    );

    it.each(["announced before the coordinator starts", "in either order"])(
        "16: a creator whose readiness Subscribe J never sees is live through its replication and blocks until contained (%s)",
        async (order) => {
            const creator = await createDonor(5, "join-creator");
            const replica = await readyReplica(creator);
            const creatorHash = hashOf(creator.peer);
            const peer = await createPeer();
            const joinerHash = hashOf(peer);
            // J never sees the creator's readiness-topic subscription,
            // neither listed nor as an event; the creator's log replication
            // is untouched.
            globalThis.__SFS_READINESS_TRANSPORT_HOOKS__ = {
                hideSubscriber: (observer, subscriber) =>
                    observer === joinerHash && subscriber === creatorHash,
            };
            // A busy creator: it answers once the test lets it.
            const busy = holdOpens(creator.fs);
            restores.push(busy.release);
            const rows = await namespaceRows(creator.fs);
            // J's log exchanges replication info with the peers it dialed
            // while J's open runs, and the open starts the coordinator a few
            // milliseconds later (the order traced runs of this test show;
            // it varies with load). Shared-log announces an idle creator
            // once, so that announcement reaches only the runtime's
            // recorder, whose record the coordinator's discovery counts. The
            // first case fixes that order: J's coordinator starts once J's
            // log lists the creator as a replicator. The second leaves the
            // order to the run.
            if (order === "announced before the coordinator starts") {
                const start = Coordinator.prototype.start;
                Coordinator.prototype.start = function (this: Coordinator) {
                    if (this.ports.transport.self !== joinerHash) {
                        return start.call(this);
                    }
                    const go = () => start.call(this);
                    void waitUntil(async () =>
                        expect(
                            await this.ports.transport.replicators()
                        ).toContain(creatorHash)
                    ).then(go, go);
                };
                restores.push(() => (Coordinator.prototype.start = start));
            }

            const joiner = await joinOf([creator, replica], { peer });
            const coordinator = coordinatorOf(joiner.fs);
            const evaluations: Array<{ satisfied: boolean; creator?: string }> =
                [];
            const ports = coordinator.ports as any;
            const onEvaluate = ports.onEvaluate;
            ports.onEvaluate = (evaluation: { satisfied: boolean }) => {
                evaluations.push({
                    satisfied: evaluation.satisfied,
                    creator: coordinator.record(creatorHash)?.state,
                });
                onEvaluate?.(evaluation);
            };
            await waitUntil(() => {
                expect(resultOf(joiner.fs, replica.peer)?.qualified).toBe(true);
                expect(busy.held).toBeGreaterThan(0);
                // Replication flows: J holds the creator's rows.
                expect(missingFromTap(joiner.fs, rows)).toEqual([]);
            });

            // Past the creator's first OPEN attempt (5 s): the creator stays
            // Required, since the replication it announced to J during this
            // open is a sign of life (design 2.1 "Live", test 16).
            const until = Date.now() + 6_500;
            while (Date.now() < until) {
                const record = coordinator.record(creatorHash);
                expect(record, "the creator has a record").toBeDefined();
                expect(
                    BLOCKING_STATES.has(record!.state),
                    `the creator blocks (state ${record!.state}, live ${record!.live}, confirmOnly ${record!.confirmOnly})`
                ).toBe(true);
                expect(coordinator.satisfied()).toBe(false);
                expect(joiner.fs.bootstrapStatus().writeReady).toBe(false);
                await sleep(100);
            }
            const record = coordinator.record(creatorHash)!;
            expect(record.live).toBe(true);
            expect(record.confirmOnly).toBe(false);
            expect([...record.via]).toContain("replicator");
            expect([...record.via]).not.toContain("subscriber");
            expect(readinessOf(joiner.fs)!.required).toEqual([creatorHash]);

            busy.release();
            await joiner.fs.awaitWriteReady({ timeout: 60_000 });
            expect(resultOf(joiner.fs, creator.peer)).toMatchObject({
                qualified: true,
                source: "creator",
            });
            expect(
                evaluations.filter(
                    ({ satisfied, creator }) =>
                        satisfied && creator !== "contained"
                )
            ).toEqual([]);
        }
    );

    it("44: a head whose index write is delayed after its log commit is never pulled, and J waits until it is indexed", async () => {
        const donor = await createDonor(3);
        const donorEntries = entriesOf(donor.fs);
        const base = await namespaceRows(donor.fs);

        // J's index write of the change that adds the late file's naming
        // row (and whatever else that change adds) waits for the test,
        // after the log committed it.
        const writes = holdIndexWrites(
            donorEntries,
            (value) => value instanceof NamingEvent && value.name === "late.txt"
        );
        restores.push(writes.restore);
        // Every SharedLog.join, by store: the session's pulls go through it
        // (ports.ts `sharedLogPullPorts`).
        const logOwner = ownerOf(donorEntries.log, "join");
        const logJoin = logOwner.join;
        const joins: Array<{ log: unknown; heads: string[] }> = [];
        logOwner.join = function (this: unknown, heads: any[], ...rest: any[]) {
            joins.push({
                log: this,
                heads: (heads ?? []).map((head) =>
                    typeof head === "string" ? head : head?.hash
                ),
            });
            return logJoin.call(this, heads, ...rest);
        };
        restores.push(() => (logOwner.join = logJoin));

        const busy = holdOpens(donor.fs);
        restores.push(busy.release);
        const joiner = await joinOf([donor]);
        const joinerEntries = entriesOf(joiner.fs);
        const changed: string[] = [];
        joinerEntries.events.addEventListener("change", (event: any) => {
            for (const value of event.detail.added) {
                changed.push(value.__context?.head);
            }
        });
        await waitUntil(() =>
            expect(missingFromTap(joiner.fs, base)).toEqual([])
        );

        await donor.fs.writeFile("/late.txt", "late");
        const late = await namespaceRows(donor.fs);
        await within(writes.reached, 30_000, "J logged no late row");
        expect(writes.held).toHaveLength(1);
        const [{ head, value }] = writes.held;
        const key = (value as NamingEvent).id;
        expect(late.get(key)).toBe(head);
        // Logged, not indexed.
        expect(await joinerEntries.log.log.has(head)).toBe(true);
        expect(
            await documentsIndexPort(joinerEntries, NAMESPACE_V1).readHead(key)
        ).toBeUndefined();

        busy.release();
        const coordinator = coordinatorOf(joiner.fs);
        const donorHash = hashOf(donor.peer);
        await waitUntil(() => {
            const session = coordinator.record(donorHash)?.session;
            expect(
                session?.debug().scopes[SCOPE_NAMESPACE_V1]?.logged ?? 0
            ).toBeGreaterThan(0);
        });
        expect(coordinator.record(donorHash)!.state).toBe("reconciling");
        expect(coordinator.satisfied()).toBe(false);
        const error = await timeoutOf(joiner.fs, 1_500);
        expect(error.readiness).toMatchObject({
            state: "reconciling",
            satisfied: false,
            required: [donorHash],
        });
        // The hold is on the product path: the head's change event waits
        // for it.
        expect(changed).not.toContain(head);

        const flip = atReady(joiner.fs, () =>
            missingFromTap(joiner.fs, new Map([[key, head]]))
        );
        writes.release();
        await joiner.fs.awaitWriteReady({ timeout: 60_000 });
        expect(await flip).toEqual([]);
        expect(changed).toContain(head);
        expect(await missingFromIndex(joiner.fs, late)).toEqual([]);
        // Never pulled: no join of J's store carried the logged head.
        const pulled = joins
            .filter(({ log }) => log === joinerEntries.log)
            .flatMap(({ heads }) => heads);
        expect(pulled).not.toContain(head);
        const result = resultOf(joiner.fs, donor.peer)!;
        expect(result).toMatchObject({ qualified: true, count: late.size });
        expect(result.missingAtStart).toBeGreaterThanOrEqual(1);
    });
});
