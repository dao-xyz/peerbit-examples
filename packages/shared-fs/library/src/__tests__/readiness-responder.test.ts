import {
    Ed25519Keypair,
    randomBytes,
    type PublicSignKey,
} from "@peerbit/crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { NamingEvent } from "../model.js";
import { AnchorHost } from "../readiness/anchor-host.js";
import {
    Cells,
    cellKey,
    decodeCellsInto,
    emptyRemoteCells,
    peelDifference,
} from "../readiness/cells.js";
import {
    CELL_BYTES,
    DIGEST_BYTES,
    M,
    SESSION_IDLE_MS,
} from "../readiness/constants.js";
import { digestToHead, headDigest } from "../readiness/digest.js";
import {
    Responder,
    type ProvenanceState,
    type Timers,
} from "../readiness/responder.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    TRUST_V1,
} from "../readiness/scopes.js";
import { ScopeTap, documentsIndexPort } from "../readiness/tap.js";
import {
    CellsV1,
    ERROR_CODE,
    ErrorV1,
    HeaderV1,
    ListV1,
    NOTICE_REASON,
    OPEN_FLAG_LIST,
    PROVENANCE_PHASES,
    PROVENANCE_SOURCES,
    StateNoticeV1,
} from "../readiness/wire.js";
import {
    DirectNetwork,
    ReadinessClient,
    sameBytes,
} from "./readiness-client.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The responder (M1 plan section 8: test 31 and test 46, responder halves):
 * snapshots per session, D_R against the index, first-flight cells, cells
 * requests, list mode, caps and BUSY with notices, idle expiry, late
 * requests, wire errors, and honest provenance.
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

class FakeTimers implements Timers {
    private now = 0;
    private nextId = 1;
    private readonly due = new Map<number, { at: number; fn: () => void }>();
    set(fn: () => void, ms: number) {
        const id = this.nextId++;
        this.due.set(id, { at: this.now + ms, fn });
        return id;
    }
    clear(handle: unknown) {
        this.due.delete(handle as number);
    }
    armed() {
        return this.due.size;
    }
    advance(ms: number) {
        this.now += ms;
        for (const [id, timer] of [...this.due].sort(
            (a, b) => a[1].at - b[1].at
        )) {
            if (timer.at <= this.now && this.due.delete(id)) timer.fn();
        }
    }
}

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    (fs.program as any).readinessRuntime;
const namespaceLogId = (fs: SharedFsHandle): Uint8Array =>
    (fs.program as any).entries.log.log.id;
const trustLogId = (fs: SharedFsHandle): Uint8Array =>
    (fs.program as any).trustGraph.trustGraph.log.log.id;

/** The scope's rows read from the index (independent of the tap). */
const indexRows = async (fs: SharedFsHandle, scope = NAMESPACE_V1) => {
    const documents =
        scope === NAMESPACE_V1
            ? (fs.program as any).entries
            : (fs.program as any).trustGraph.trustGraph;
    const digests: Uint8Array[] = [];
    let hlc = 0n;
    for await (const rows of documentsIndexPort(documents, scope).scan()) {
        for (const row of rows) {
            digests.push(headDigest(row.head));
            if (row.modified > hlc) hlc = row.modified;
        }
    }
    const list = new Uint8Array(digests.length * DIGEST_BYTES);
    digests.forEach((digest, i) => list.set(digest, i * DIGEST_BYTES));
    return { digests, list, hlc };
};

/** D_R of the index rows, computed by the runtime's own lane set. */
const anchorOfIndex = async (fs: SharedFsHandle, scope = NAMESPACE_V1) => {
    const { list } = await indexRows(fs, scope);
    return hex(await runtimeOf(fs).scope(scope.id)!.laneSet.digestOf(list));
};

const writeFiles = async (fs: SharedFsHandle, n: number, prefix = "f") => {
    for (let i = 0; i < n; i++) {
        await fs.writeFile(`/${prefix}${i}.txt`, `content ${prefix} ${i}`);
    }
};

const keys = async (n: number): Promise<PublicSignKey[]> =>
    Promise.all(
        Array.from(
            { length: n },
            async () => (await Ed25519Keypair.create()).publicKey
        )
    );

/**
 * A responder over one namespace scope on a fake index and a private anchor
 * host (worker or inline), so a test can fault the tap or crash the worker
 * without touching the process-wide host.
 */
const fakeResponder = async (
    rows: number,
    mode?: "inline",
    provenance?: () => ProvenanceState,
    options: { started?: Promise<void> } = {}
) => {
    const heads = new Map<string, string>();
    const port = {
        readHead: async (key: unknown) => {
            const h = heads.get(key as string);
            return h ? { head: h, modified: 1n } : undefined;
        },
        scan: async function* () {
            yield [...heads].map(([key, h]) => ({
                key,
                head: h,
                modified: 1n,
            }));
        },
        count: async () => heads.size,
    };
    for (let i = 0; i < rows; i++) {
        heads.set(`n${i}`, digestToHead(randomBytes(DIGEST_BYTES)));
    }
    const tap = new ScopeTap(NAMESPACE_V1, port);
    const key = cellKey("fake-responder");
    const host = await AnchorHost.create({ mode });
    const laneSet = host.open(NAMESPACE_V1.ivTag, {
        slab: () => tap.map,
        cells: { m: M, k0: key[0], k1: key[1] },
    });
    tap.addSink({
        apply: (digest, sign) => laneSet.apply(digest, sign),
        reset: () => laneSet.reset(tap.epoch),
    });
    await tap.seedFromScan();
    const logId = new Uint8Array(32).fill(7);
    const scope = {
        descriptor: NAMESPACE_V1,
        tap,
        laneSet,
        logId,
        started: options.started ?? Promise.resolve(),
    };
    const network = new DirectNetwork();
    const responder = new Responder(
        {
            openNonce: new Uint8Array(16),
            scope: (id) => (id === SCOPE_NAMESPACE_V1 ? scope : undefined),
            answering: () => true,
        },
        {
            send: network.send,
            provenance:
                provenance ??
                (() => ({
                    writeReady: true,
                    source: "creator",
                    fullReplica: true,
                    phase: "off",
                })),
            timers: new FakeTimers(),
        }
    );
    network.responder = responder;
    const add = (id: string) => {
        const value = Object.create(NamingEvent.prototype);
        value.id = id;
        value.__context = {
            head: digestToHead(randomBytes(DIGEST_BYTES)),
            modified: 2n,
        };
        heads.set(id, value.__context.head);
        tap.onChange({ detail: { added: [value], removed: [] } });
    };
    return {
        tap,
        host,
        network,
        responder,
        add,
        scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }],
        logId,
        close: () => {
            responder.dispose();
            laneSet.close();
        },
    };
};

/** Lets queued handlers and their sends run. */
const settle = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

/** A responder on a real runtime, answering through an in-memory network. */
const directResponder = (fs: SharedFsHandle, timers?: Timers) => {
    const runtime = runtimeOf(fs);
    const network = new DirectNetwork();
    const responder = new Responder(
        {
            openNonce: runtime.openNonce,
            scope: (id) => runtime.scope(id),
            answering: () => !runtime.blocked && !runtime.disposed,
        },
        {
            send: network.send,
            provenance: (): ProvenanceState =>
                (fs.program as any).readinessProvenance(),
            timers,
        }
    );
    network.responder = responder;
    return { runtime, network, responder };
};

describe("readiness responder", () => {
    const peers: Peerbit[] = [];
    const roots: string[] = [];
    afterEach(async () => {
        await stopTestPeers(peers);
        await Promise.all(
            roots
                .splice(0)
                .map((root) => rm(root, { recursive: true, force: true }))
        );
    });

    const createPeer = async (directory?: string) => {
        const peer = await Peerbit.create(
            directory ? { directory } : undefined
        );
        peers.push(peer);
        return peer;
    };
    const stopPeer = async (peer: Peerbit) => {
        peers.splice(peers.indexOf(peer), 1);
        await peer.stop();
    };

    describe("over the RPC", () => {
        it("answers OPEN with one snapshot per session, first-flight cells and cells requests", async () => {
            const [donorPeer, joinerPeer] = await Promise.all([
                createPeer(),
                createPeer(),
            ]);
            await joinerPeer.dial(donorPeer);
            const fs = await openSharedFs({
                peerbit: donorPeer,
                rootKey: donorPeer.identity.publicKey,
            });
            await writeFiles(fs, 20);
            const runtime = runtimeOf(fs);
            await runtime.whenStarted();
            const { client } = await ReadinessClient.overRpc(
                joinerPeer,
                (fs.program as any).readiness.topic,
                donorPeer.identity.publicKey
            );
            const logId = namespaceLogId(fs);
            const tap = runtime.namespace!;
            const count = tap.count;
            expect(count).toBeGreaterThan(20);
            const { digests: rows, hlc } = await indexRows(fs);
            expect(rows.length).toBe(count);

            // J holds all but 5 of R's rows: 0 < gapEst <= 256 -> pushed cells.
            const sessionId = new Uint8Array(16).fill(1);
            client.open({
                sessionId,
                scopes: [
                    { scope: SCOPE_NAMESPACE_V1, logId, count: count - 5 },
                    {
                        scope: SCOPE_TRUST_V1,
                        logId: trustLogId(fs),
                        count: 0,
                    },
                ],
            });
            const header = await client.next(
                HeaderV1,
                (message) =>
                    sameBytes(message.sessionId, sessionId) &&
                    message.scope === SCOPE_NAMESPACE_V1
            );
            expect(header.count).toBe(count);
            expect(sameBytes(header.logId, logId)).toBe(true);
            expect(header.logId.length).toBe(32);
            expect(hex(header.anchor)).toBe(await anchorOfIndex(fs));
            // hlc never decreases; with no CUT it is the index maximum.
            expect(header.hlc).toBe(hlc);
            expect(header.above).toBe(0);
            expect(header.cellsFrom).toBe(0);
            expect(header.cells.length).toBe(64 * CELL_BYTES);
            expect(PROVENANCE_SOURCES[header.provenance.source]).toBe(
                "creator"
            );
            expect(header.provenance.writeReady).toBe(true);
            expect(header.provenance.fullReplica).toBe(true);
            expect(
                sameBytes(header.provenance.openNonce, runtime.openNonce)
            ).toBe(true);
            expect(header.provenance.caps).toBe(0);
            const trustHeader = await client.next(
                HeaderV1,
                (message) =>
                    sameBytes(message.sessionId, sessionId) &&
                    message.scope === SCOPE_TRUST_V1
            );
            expect(trustHeader.count).toBe(
                (await indexRows(fs, TRUST_V1)).digests.length
            );
            expect(hex(trustHeader.anchor)).toBe(
                await anchorOfIndex(fs, TRUST_V1)
            );

            // The pushed prefix (grown with CellsReq if needed) peels to
            // exactly the 5 rows J lacks.
            const [k0, k1] = cellKey(runtime.address);
            const joiner = new Cells(M, k0, k1);
            for (const digest of rows.slice(5)) joiner.apply(digest, 1);
            const received = emptyRemoteCells();
            decodeCellsInto(received, 0, header.cells);
            let m = 64;
            let result = peelDifference(received, joiner, m);
            while (!result.ok && m < M) {
                const to = Math.min(M, 4 * m);
                await client.cellsReq(
                    sessionId,
                    SCOPE_NAMESPACE_V1,
                    logId,
                    m,
                    to
                );
                const cells = await client.next(
                    CellsV1,
                    (message) =>
                        sameBytes(message.sessionId, sessionId) &&
                        message.from === m
                );
                decodeCellsInto(received, cells.from, cells.cells);
                m = to;
                result = peelDifference(received, joiner, m);
            }
            expect(result.ok).toBe(true);
            expect(new Set(result.plus.map(hex))).toEqual(
                new Set(rows.slice(0, 5).map(hex))
            );
            expect(result.minus).toEqual([]);

            // R moves on; a second attempt of the session gets the same
            // snapshot, a new session the new one.
            await writeFiles(fs, 3, "later");
            const after = client.inbox.length;
            client.open({
                sessionId,
                attempt: 2,
                scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count }],
            });
            const again = await client.next(
                HeaderV1,
                (message) =>
                    sameBytes(message.sessionId, sessionId) &&
                    message.scope === SCOPE_NAMESPACE_V1,
                { after }
            );
            expect(again.count).toBe(header.count);
            expect(hex(again.anchor)).toBe(hex(header.anchor));
            // Equal counts: no gap, so nothing pushed this time.
            expect(again.cells.length).toBe(0);
            const fresh = client.open({
                scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }],
            });
            const newer = await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, fresh.sessionId)
            );
            expect(newer.count).toBeGreaterThan(header.count);
            expect(hex(newer.anchor)).toBe(await anchorOfIndex(fs));
            // An empty joiner below 256 rows: the first flight covers 1.8 x
            // the gap, rounded up to 32 cells.
            expect(newer.cells.length).toBe(
                Math.ceil((1.8 * newer.count) / 32) * 32 * CELL_BYTES
            );
            // A gap above 256 pushes nothing (the joiner waits for sync).
            const far = client.open({
                scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count: 100_000 }],
            });
            const farHeader = await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, far.sessionId)
            );
            expect(farHeader.cells.length).toBe(0);

            // A late cells request on the first session still answers from
            // its snapshot; after CLOSE the session is gone.
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, logId, 0, 2);
            const late = await client.next(
                CellsV1,
                (message) =>
                    sameBytes(message.sessionId, sessionId) &&
                    message.from === 0
            );
            expect(hex(late.cells)).toBe(
                hex(header.cells.subarray(0, 2 * CELL_BYTES))
            );
            await client.close(sessionId);
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, logId, 0, 2);
            const expired = await client.next(ErrorV1, (message) =>
                sameBytes(message.sessionId, sessionId)
            );
            expect(expired.code).toBe(ERROR_CODE.EXPIRED);
        });

        it("keeps program.waitFor working with the readiness topic in the topic set", async () => {
            const [donorPeer, joinerPeer] = await Promise.all([
                createPeer(),
                createPeer(),
            ]);
            await joinerPeer.dial(donorPeer);
            const donor = await openSharedFs({ peerbit: donorPeer });
            const joiner = await openSharedFs({
                peerbit: joinerPeer,
                address: donor.address,
                allowPartialWrites: true,
            });
            // The RPC child adds its topic to the program's set, so the
            // program-level wait now also requires the readiness topic.
            const topics: string[] = (
                donor.program as any
            ).getAllTopicsIncludingThis();
            expect(topics).toContain((donor.program as any).readiness.topic);
            await (joiner.program as any).waitFor(
                donorPeer.identity.publicKey,
                { timeout: 30_000 }
            );
            await (donor.program as any).waitFor(
                joinerPeer.identity.publicKey,
                { timeout: 30_000 }
            );
        });

        it("answers version, log-id and scope errors (test 31, responder half)", async () => {
            const [donorPeer, joinerPeer] = await Promise.all([
                createPeer(),
                createPeer(),
            ]);
            await joinerPeer.dial(donorPeer);
            const fs = await openSharedFs({ peerbit: donorPeer });
            await writeFiles(fs, 2);
            await runtimeOf(fs).whenStarted();
            const { client } = await ReadinessClient.overRpc(
                joinerPeer,
                (fs.program as any).readiness.topic,
                donorPeer.identity.publicKey
            );
            const logId = namespaceLogId(fs);
            const errorFor = async (sessionId: Uint8Array) =>
                (
                    await client.next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, sessionId)
                    )
                ).code;

            const v2 = client.open({
                version: 2,
                scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }],
            });
            expect(await errorFor(v2.sessionId)).toBe(ERROR_CODE.UNSUPPORTED);

            const wrongLog = client.open({
                scopes: [
                    {
                        scope: SCOPE_NAMESPACE_V1,
                        logId: new Uint8Array(32).fill(7),
                        count: 0,
                    },
                ],
            });
            expect(await errorFor(wrongLog.sessionId)).toBe(ERROR_CODE.SCOPE);

            // No rootKey: this store has no trust scope.
            const noTrust = client.open({
                scopes: [
                    { scope: SCOPE_NAMESPACE_V1, logId, count: 0 },
                    { scope: SCOPE_TRUST_V1, logId, count: 0 },
                ],
            });
            expect(await errorFor(noTrust.sessionId)).toBe(ERROR_CODE.SCOPE);

            const unknown = new Uint8Array(16).fill(9);
            await client.cellsReq(unknown, SCOPE_NAMESPACE_V1, logId, 0, 1);
            expect(await errorFor(unknown)).toBe(ERROR_CODE.EXPIRED);

            const open = client.open({
                scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }],
            });
            await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, open.sessionId)
            );
            const before = client.inbox.length;
            await client.cellsReq(
                open.sessionId,
                SCOPE_NAMESPACE_V1,
                new Uint8Array(32).fill(1),
                0,
                1
            );
            expect(
                (
                    await client.next(
                        ErrorV1,
                        (message) =>
                            sameBytes(message.sessionId, open.sessionId),
                        { after: before }
                    )
                ).code
            ).toBe(ERROR_CODE.SCOPE);
            const beforeRange = client.inbox.length;
            await client.cellsReq(
                open.sessionId,
                SCOPE_NAMESPACE_V1,
                logId,
                0,
                M + 1
            );
            expect(
                (
                    await client.next(
                        ErrorV1,
                        (message) =>
                            sameBytes(message.sessionId, open.sessionId),
                        { after: beforeRange }
                    )
                ).code
            ).toBe(ERROR_CODE.SCOPE);
        });
    });

    describe("in memory, on a real runtime", () => {
        it("caps sessions at 4 per peer and 16 in total, with BUSY and a capacity notice (test 46, responder half)", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer });
            await writeFiles(fs, 3);
            const { runtime, network, responder } = directResponder(
                fs,
                new FakeTimers()
            );
            await runtime.whenStarted();
            const logId = namespaceLogId(fs);
            const scopes = [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }];
            const from = await keys(5);
            const clients = from.map((key) => network.client(key));

            const opened: Uint8Array[][] = clients.map(() => []);
            for (let p = 0; p < 4; p++) {
                for (let s = 0; s < 4; s++) {
                    opened[p].push(clients[p].open({ scopes }).sessionId);
                }
            }
            // A fifth session of one peer: BUSY.
            const fifth = clients[0].open({ scopes });
            // A seventeenth session overall: BUSY.
            const seventeenth = clients[4].open({ scopes });
            for (let p = 0; p < 4; p++) {
                for (const sessionId of opened[p]) {
                    await clients[p].next(HeaderV1, (message) =>
                        sameBytes(message.sessionId, sessionId)
                    );
                }
            }
            expect(
                (
                    await clients[0].next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, fifth.sessionId)
                    )
                ).code
            ).toBe(ERROR_CODE.BUSY);
            expect(
                (
                    await clients[4].next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, seventeenth.sessionId)
                    )
                ).code
            ).toBe(ERROR_CODE.BUSY);
            expect(responder.debug().sessions).toBe(16);
            expect(responder.debug().busyWaiters).toBe(2);
            // All 16 sessions shared one snapshot.
            expect(responder.stats.freezes).toBe(1);

            // Capacity frees: the peer the total cap refused gets a
            // directed notice.
            await clients[1].close(opened[1][0]);
            const notice = await clients[4].next(StateNoticeV1);
            expect(notice.reason).toBe(NOTICE_REASON.CAPACITY);
            expect(
                sameBytes(notice.provenance.openNonce, runtime.openNonce)
            ).toBe(true);
            // The peer its own cap refused still holds 4: it keeps waiting.
            expect(
                clients[0].inbox.some((m) => m instanceof StateNoticeV1)
            ).toBe(false);
            expect(responder.debug().busyWaiters).toBe(1);
            // The notified peer now gets a session.
            const retry = clients[4].open({ scopes });
            await clients[4].next(HeaderV1, (message) =>
                sameBytes(message.sessionId, retry.sessionId)
            );
            // One of its own sessions ends: now it hears.
            await clients[0].close(opened[0][0]);
            await clients[0].next(StateNoticeV1);
            expect(responder.debug().busyWaiters).toBe(0);
            expect(responder.noticeTargets.size).toBe(5);
            responder.dispose();
            expect(responder.debug()).toMatchObject({
                sessions: 0,
                armedTimers: 0,
            });
        });

        it("notices a waiter only when the cap that refused it has room", async () => {
            const r = await fakeResponder(20, "inline");
            const [holder, churner, ...waiting] = await keys(7);
            const waiters = waiting.map((key) => r.network.client(key));
            let reasks = 0;
            for (const client of waiters) {
                const receive = client.receive.bind(client);
                client.receive = (message) => {
                    receive(message);
                    if (message instanceof StateNoticeV1) {
                        reasks++;
                        client.open({
                            scopes: r.scopes,
                            flags: OPEN_FLAG_LIST,
                        });
                    }
                };
            }
            // H holds the list slot; five peers wait for list mode.
            const held = r.network.client(holder);
            const list = held.open({ scopes: r.scopes, flags: OPEN_FLAG_LIST });
            await held.next(HeaderV1);
            for (const client of waiters) {
                client.open({ scopes: r.scopes, flags: OPEN_FLAG_LIST });
            }
            await settle();
            expect(r.responder.debug().busyWaiters).toBe(5);
            // Another peer opens and closes plain sessions: no list waiter
            // can be served, so none is noticed.
            const churn = r.network.client(churner);
            for (let i = 0; i < 10; i++) {
                const { sessionId } = churn.open({ scopes: r.scopes });
                await churn.next(HeaderV1, (message) =>
                    sameBytes(message.sessionId, sessionId)
                );
                await churn.close(sessionId);
            }
            await settle();
            expect(r.responder.stats.notices).toBe(0);
            expect(reasks).toBe(0);
            // The list slot frees: every list waiter hears once.
            await held.close(list.sessionId);
            await settle();
            expect(r.responder.stats.notices).toBe(5);
            expect(reasks).toBe(5);
            r.close();
        });

        it("runs no freeze and sends no header for a session that ended before its freeze", async () => {
            let start!: () => void;
            const started = new Promise<void>((resolve) => (start = resolve));
            const r = await fakeResponder(20, "inline", undefined, {
                started,
            });
            let counted = 0;
            const above = r.tap.above.bind(r.tap);
            r.tap.above = (hlc: bigint) => {
                counted++;
                return above(hlc);
            };
            const [key] = await keys(1);
            const client = r.network.client(key);
            // OPEN then CLOSE while the scope's start is pending: each pair
            // passes the caps, since CLOSE frees the slot at once.
            for (let i = 0; i < 200; i++) {
                const { sessionId } = client.open({
                    scopes: r.scopes,
                    hlcProved: BigInt(i + 1),
                });
                await client.close(sessionId);
            }
            await settle();
            expect(r.responder.debug().sessions).toBe(0);
            start();
            await settle();
            expect(r.responder.stats.freezes).toBe(0);
            expect(counted).toBe(0);
            expect(
                r.network.sent.filter(
                    ({ message }) => message instanceof HeaderV1
                )
            ).toEqual([]);
            // A live session is still answered.
            client.open({ scopes: r.scopes });
            await client.next(HeaderV1);
            r.close();
        });

        it("ends a session it answers EXPIRED", async () => {
            const r = await fakeResponder(20, "inline");
            const [key] = await keys(1);
            const client = r.network.client(key);
            const { sessionId } = client.open({ scopes: r.scopes });
            await client.next(HeaderV1);
            // Beyond M cells: EXPIRED, and the session is gone.
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, r.logId, 0, M);
            await client.next(CellsV1);
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, r.logId, 0, 1);
            expect(
                (
                    await client.next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, sessionId)
                    )
                ).code
            ).toBe(ERROR_CODE.EXPIRED);
            expect(r.responder.debug().sessions).toBe(0);
            let after = client.inbox.length;
            await client.listPage(sessionId, SCOPE_NAMESPACE_V1, r.logId, 0);
            expect(
                (await client.next(ErrorV1, () => true, { after })).code
            ).toBe(ERROR_CODE.EXPIRED);
            expect(
                client.inbox.slice(after).some((m) => m instanceof ListV1)
            ).toBe(false);

            // A plain session listing after its epoch moved (deviation c):
            // EXPIRED, and its slot is free for the fresh list session.
            const opened: Uint8Array[] = [];
            for (let i = 0; i < 4; i++) {
                const plain = client.open({ scopes: r.scopes });
                await client.next(HeaderV1, (message) =>
                    sameBytes(message.sessionId, plain.sessionId)
                );
                opened.push(plain.sessionId);
            }
            r.add(`moved`);
            after = client.inbox.length;
            await client.listPage(opened[0], SCOPE_NAMESPACE_V1, r.logId, 0);
            expect(
                (await client.next(ErrorV1, () => true, { after })).code
            ).toBe(ERROR_CODE.EXPIRED);
            expect(r.responder.debug().sessions).toBe(3);
            const fresh = client.open({
                scopes: r.scopes,
                flags: OPEN_FLAG_LIST,
            });
            const header = await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, fresh.sessionId)
            );
            expect(header.count).toBe(21);
            r.close();
        });

        it("answers BUSY for a faulted tap without a notice ping-pong", async () => {
            const r = await fakeResponder(5, "inline");
            r.tap.faulted = new Error("faulted for the test");
            const [k1, k2] = await keys(2);
            const clients = [r.network.client(k1), r.network.client(k2)];
            // Each peer re-asks on every notice, as the design's busy state
            // does.
            for (const client of clients) {
                const receive = client.receive.bind(client);
                client.receive = (message) => {
                    receive(message);
                    if (message instanceof StateNoticeV1) {
                        client.open({ scopes: r.scopes });
                    }
                };
            }
            clients[0].open({ scopes: r.scopes });
            clients[1].open({ scopes: r.scopes });
            await settle();
            const kinds = r.network.sent.map(
                ({ message }) => message.constructor.name
            );
            expect(kinds).toEqual(["ErrorV1", "ErrorV1"]);
            expect((r.network.sent[0].message as ErrorV1).code).toBe(
                ERROR_CODE.BUSY
            );
            expect(r.responder.stats.notices).toBe(0);
            expect(r.responder.debug()).toMatchObject({
                sessions: 0,
                busyWaiters: 2,
            });
            r.close();
        });

        it("retries a freeze across a worker restart instead of answering BUSY", async () => {
            const r = await fakeResponder(50);
            expect(r.host.mode).toBe("worker");
            const [key] = await keys(1);
            const client = r.network.client(key);
            // Warm the worker, then crash it under the next freeze.
            await r.tap.verifyIdle();
            client.open({ scopes: r.scopes });
            await client.next(HeaderV1);
            r.add("fresh");
            const { sessionId } = client.open({ scopes: r.scopes });
            r.host.crashWorkerForTest();
            const header = await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, sessionId)
            );
            expect(header.count).toBe(51);
            expect(r.host.stats.respawns).toBe(1);
            expect(r.responder.stats.busy).toBe(0);
            r.close();
        });

        it("serves at most M cells per session and shares list copies and `above` per epoch", async () => {
            const r = await fakeResponder(40, "inline");
            const [key] = await keys(1);
            const client = r.network.client(key);
            const { sessionId } = client.open({ scopes: r.scopes });
            await client.next(HeaderV1);
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, r.logId, 0, M);
            await client.next(CellsV1);
            // The whole prefix was served: one more cell expires the session.
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, r.logId, 0, 1);
            expect(
                (
                    await client.next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, sessionId)
                    )
                ).code
            ).toBe(ERROR_CODE.EXPIRED);
            expect(r.responder.stats.cellsSent).toBe(M);

            // List sessions one after another at one epoch: one copy.
            for (let i = 0; i < 3; i++) {
                const list = client.open({
                    scopes: r.scopes,
                    flags: OPEN_FLAG_LIST,
                });
                await client.next(HeaderV1, (message) =>
                    sameBytes(message.sessionId, list.sessionId)
                );
                await client.close(list.sessionId);
            }
            expect(r.responder.stats.listCopies).toBe(1);

            // `above` is counted once per hlcProved at one epoch.
            let counted = 0;
            const above = r.tap.above.bind(r.tap);
            r.tap.above = (hlc: bigint) => {
                counted++;
                return above(hlc);
            };
            for (let i = 0; i < 3; i++) {
                const opened = client.open({ scopes: r.scopes, hlcProved: 1n });
                await client.next(HeaderV1, (message) =>
                    sameBytes(message.sessionId, opened.sessionId)
                );
                await client.close(opened.sessionId);
            }
            expect(counted).toBe(1);
            r.close();
        });

        it("keeps at most one list copy alive while sessions outlive their epochs", async () => {
            const r = await fakeResponder(2000, "inline");
            const holders = await keys(4);
            const [lister] = await keys(1);
            /** Distinct hash lists the responder can still reach. */
            const reachableLists = async () => {
                const lists = new Set<Uint8Array>();
                const responder = r.responder as any;
                for (const session of responder.sessions.values()) {
                    const frozen = await session.frozen;
                    if (typeof frozen === "number") continue;
                    for (const scope of frozen) {
                        if (scope.list) lists.add(scope.list);
                        if (scope.snapshot.list) lists.add(scope.snapshot.list);
                    }
                }
                for (const snapshot of responder.snapshots.values()) {
                    if (snapshot.list) lists.add(snapshot.list);
                }
                for (const cached of responder.lists?.values() ?? []) {
                    lists.add(cached.list);
                }
                return lists.size;
            };
            for (let round = 0; round < 15; round++) {
                r.add(`epoch${round}`);
                // A session that stays open at this epoch (idle timers
                // never fire here).
                const holder = r.network.client(holders[round % 4]);
                const held = holder.open({ scopes: r.scopes });
                await holder.next(HeaderV1, (message) =>
                    sameBytes(message.sessionId, held.sessionId)
                );
                // A list session at the same epoch, then closed.
                const client = r.network.client(lister);
                const list = client.open({
                    scopes: r.scopes,
                    flags: OPEN_FLAG_LIST,
                });
                await client.next(HeaderV1, (message) =>
                    sameBytes(message.sessionId, list.sessionId)
                );
                await client.close(list.sessionId);
                await settle();
            }
            expect(r.responder.debug()).toMatchObject({
                sessions: 15,
                listSession: false,
            });
            expect(r.responder.stats.listCopies).toBe(15);
            expect(await reachableLists()).toBe(1);
            r.close();
        });

        it("sends every attempt of a session the provenance of its first freeze", async () => {
            let provenance: ProvenanceState = {
                writeReady: false,
                source: "none",
                fullReplica: true,
                phase: "off",
            };
            const r = await fakeResponder(1000, "inline", () => provenance);
            const [key] = await keys(1);
            const client = r.network.client(key);
            const { sessionId } = client.open({ scopes: r.scopes });
            const first = await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, sessionId)
            );
            expect(first.provenance.writeReady).toBe(false);
            // R pulls the rows it lacked and turns ready (PR-3: reconciled).
            for (let i = 0; i < 50; i++) r.add(`pulled${i}`);
            provenance = {
                ...provenance,
                writeReady: true,
                source: "reconciled",
            };
            // A retry of the same session gets the gated snapshot, so it
            // must not carry the later, qualifying state.
            const after = client.inbox.length;
            client.open({ sessionId, attempt: 2, scopes: r.scopes });
            const second = await client.next(
                HeaderV1,
                (message) => sameBytes(message.sessionId, sessionId),
                { after }
            );
            expect(second.count).toBe(1000);
            expect(hex(second.anchor)).toBe(hex(first.anchor));
            expect(second.provenance.writeReady).toBe(false);
            expect(PROVENANCE_SOURCES[second.provenance.source]).toBe("none");
            // A fresh session freezes the set now, with the state now.
            const fresh = client.open({ scopes: r.scopes });
            const third = await client.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, fresh.sessionId)
            );
            expect(third.count).toBe(1050);
            expect(third.provenance.writeReady).toBe(true);
            expect(PROVENANCE_SOURCES[third.provenance.source]).toBe(
                "reconciled"
            );
            r.close();
        });

        it("expires idle sessions after 30 s and answers late requests before that", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer });
            await writeFiles(fs, 2);
            const timers = new FakeTimers();
            const { runtime, network, responder } = directResponder(fs, timers);
            await runtime.whenStarted();
            const logId = namespaceLogId(fs);
            const [key] = await keys(1);
            const client = network.client(key);
            const { sessionId } = client.open({
                scopes: [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }],
            });
            await client.next(HeaderV1);
            expect(timers.armed()).toBe(1);

            timers.advance(SESSION_IDLE_MS - 1);
            const before = client.inbox.length;
            // A late request is answered and restarts the idle timer.
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, logId, 0, 4);
            const cells = await client.next(CellsV1, () => true, {
                after: before,
            });
            expect(cells.cells.length).toBe(4 * CELL_BYTES);
            timers.advance(SESSION_IDLE_MS - 1);
            expect(responder.debug().sessions).toBe(1);
            timers.advance(1);
            expect(responder.debug().sessions).toBe(0);
            expect(timers.armed()).toBe(0);
            await client.cellsReq(sessionId, SCOPE_NAMESPACE_V1, logId, 0, 4);
            expect((await client.next(ErrorV1)).code).toBe(ERROR_CODE.EXPIRED);
            // No session, no timer.
            expect(timers.armed()).toBe(0);
        });

        it("serves list mode pages that hash to D_R, one list session at a time", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer });
            await writeFiles(fs, 10);
            const { runtime, network } = directResponder(fs, new FakeTimers());
            await runtime.whenStarted();
            const logId = namespaceLogId(fs);
            const scopes = [{ scope: SCOPE_NAMESPACE_V1, logId, count: 0 }];
            const [a, b] = await keys(2);
            const clientA = network.client(a);
            const clientB = network.client(b);
            const laneSet = runtime.scope(SCOPE_NAMESPACE_V1)!.laneSet;

            const listed = clientA.open({ flags: OPEN_FLAG_LIST, scopes });
            const header = await clientA.next(HeaderV1);
            // A second list-mode session waits its turn.
            const busy = clientB.open({ flags: OPEN_FLAG_LIST, scopes });
            expect(
                (
                    await clientB.next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, busy.sessionId)
                    )
                ).code
            ).toBe(ERROR_CODE.BUSY);

            // The list is frozen with the snapshot: later writes do not
            // reach it.
            await writeFiles(fs, 2, "after");
            const list = await clientA.collectList(
                listed.sessionId,
                SCOPE_NAMESPACE_V1,
                logId
            );
            expect(list.length / DIGEST_BYTES).toBe(header.count);
            expect(hex(await laneSet.digestOf(list))).toBe(hex(header.anchor));
            const before = clientA.inbox.length;
            await clientA.listPage(
                listed.sessionId,
                SCOPE_NAMESPACE_V1,
                logId,
                1e6
            );
            const beyond = await clientA.next(ListV1, () => true, {
                after: before,
            });
            expect(beyond.hashes.length).toBe(0);
            expect(beyond.done).toBe(true);

            // Closing the list session frees the slot (and notifies B).
            await clientA.close(listed.sessionId);
            await clientB.next(StateNoticeV1);

            // A plain session may list while its epoch has not moved...
            const plain = clientB.open({ scopes });
            const plainHeader = await clientB.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, plain.sessionId)
            );
            const plainList = await clientB.collectList(
                plain.sessionId,
                SCOPE_NAMESPACE_V1,
                logId
            );
            expect(hex(await laneSet.digestOf(plainList))).toBe(
                hex(plainHeader.anchor)
            );
            // ...and gets EXPIRED once it moved (deviation c).
            const moved = clientA.open({ scopes });
            await clientA.next(HeaderV1, (message) =>
                sameBytes(message.sessionId, moved.sessionId)
            );
            await writeFiles(fs, 1, "moved");
            await clientA.listPage(
                moved.sessionId,
                SCOPE_NAMESPACE_V1,
                logId,
                0
            );
            expect(
                (
                    await clientA.next(ErrorV1, (message) =>
                        sameBytes(message.sessionId, moved.sessionId)
                    )
                ).code
            ).toBe(ERROR_CODE.EXPIRED);
        });

        it("answers nothing once the close began", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer });
            await writeFiles(fs, 1);
            const { runtime, network } = directResponder(fs, new FakeTimers());
            await runtime.whenStarted();
            const [key] = await keys(1);
            const client = network.client(key);
            runtime.block();
            client.open({
                scopes: [
                    {
                        scope: SCOPE_NAMESPACE_V1,
                        logId: namespaceLogId(fs),
                        count: 0,
                    },
                ],
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(network.sent).toEqual([]);
        });
    });

    describe("provenance", () => {
        const provenanceOf = (fs: SharedFsHandle) => {
            const state: ProvenanceState = (
                fs.program as any
            ).readinessProvenance();
            expect(PROVENANCE_SOURCES).toContain(state.source);
            expect(PROVENANCE_PHASES).toContain(state.phase);
            return state;
        };

        it("reports creator, warm, observer, gated, partial and override honestly", async () => {
            const root = await mkdtemp(
                join(tmpdir(), "shared-fs-readiness-prov-")
            );
            roots.push(root);
            const directory = join(root, "peer");

            let peer = await createPeer(directory);
            const creator = await openSharedFs({ peerbit: peer });
            await writeFiles(creator, 5);
            expect(provenanceOf(creator)).toEqual({
                writeReady: true,
                source: "creator",
                fullReplica: true,
                phase: "off",
            });
            const address = creator.address!;
            await stopPeer(peer);

            // A warm reopen reports `warm`, restores its structures and
            // answers the index's D_R.
            peer = await createPeer(directory);
            const warm = await openSharedFs({ peerbit: peer, address });
            expect(provenanceOf(warm)).toMatchObject({
                writeReady: true,
                source: "warm",
                fullReplica: true,
            });
            await runtimeOf(warm).whenStarted();
            expect(runtimeOf(warm).starts.get("namespace-v1")).toEqual({
                kind: "restored",
            });
            const { network } = directResponder(warm, new FakeTimers());
            const [key] = await keys(1);
            const client = network.client(key);
            client.open({
                scopes: [
                    {
                        scope: SCOPE_NAMESPACE_V1,
                        logId: namespaceLogId(warm),
                        count: 0,
                    },
                ],
            });
            const header = await client.next(HeaderV1);
            expect(PROVENANCE_SOURCES[header.provenance.source]).toBe("warm");
            expect(hex(header.anchor)).toBe(await anchorOfIndex(warm));
            await stopPeer(peer);

            // A warm reopen of a timer-made sidecar (`remote-settled`) is
            // writable but proves nothing: `none`, never `warm`.
            const sidecar = join(
                directory,
                "shared-fs-bootstrap",
                `${address}.json`
            );
            const proven = await readFile(sidecar, "utf8");
            await writeFile(
                sidecar,
                JSON.stringify({
                    ...JSON.parse(proven),
                    writeReadySource: "remote-settled",
                })
            );
            peer = await createPeer(directory);
            const settled = await openSharedFs({ peerbit: peer, address });
            expect(provenanceOf(settled)).toMatchObject({
                writeReady: true,
                source: "none",
                fullReplica: true,
            });
            await stopPeer(peer);
            await writeFile(sidecar, proven);

            // An observer: not a full replica, not ready.
            peer = await createPeer(directory);
            const observer = await openSharedFs({
                peerbit: peer,
                address,
                replicate: false,
            });
            expect(provenanceOf(observer)).toMatchObject({
                writeReady: false,
                source: "none",
                fullReplica: false,
            });
            await stopPeer(peer);

            // Back to a full replica without a proof and without peers:
            // gated.
            peer = await createPeer(directory);
            const gated = await openSharedFs({
                peerbit: peer,
                address,
                bootstrap: false,
            });
            expect(provenanceOf(gated)).toMatchObject({
                writeReady: false,
                source: "none",
                fullReplica: true,
            });
            await stopPeer(peer);

            // The operator override: writable, reported as such.
            peer = await createPeer(directory);
            const override = await openSharedFs({
                peerbit: peer,
                address,
                bootstrap: false,
                allowPartialWrites: true,
            });
            expect(provenanceOf(override)).toMatchObject({
                writeReady: true,
                source: "partial-override",
                fullReplica: true,
            });
            await stopPeer(peer);

            // A partial replica (factor < 1) is never reported as full.
            const partialPeer = await createPeer();
            const partial = await openSharedFs({
                peerbit: partialPeer,
                replicate: { factor: 0.5 },
            });
            expect(provenanceOf(partial)).toMatchObject({
                fullReplica: false,
                source: "none",
            });
        });
    });
});
