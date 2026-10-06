import { Ed25519Keypair, randomBytes } from "@peerbit/crypto";
import { RPC } from "@peerbit/rpc";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it } from "vitest";
import { FileVersion, NamingEvent } from "../model.js";
import {
    SharedFileSystem,
    openSharedFs,
    type SharedFsHandle,
} from "../index.js";
import { DIGEST_BYTES } from "../readiness/constants.js";
import { digestToHead, headDigest } from "../readiness/digest.js";
import type { IdKey } from "../readiness/id-map.js";
import { Responder } from "../readiness/responder.js";
import type { ReadinessRuntime } from "../readiness/runtime.js";
import {
    NAMESPACE_V1,
    SCOPE_NAMESPACE_V1,
    SCOPE_TRUST_V1,
    type ScopeId,
} from "../readiness/scopes.js";
import {
    compareScope,
    optOutOfReadinessShadow,
    type CompareOptions,
} from "../readiness/shadow.js";
import {
    ScopeTap,
    documentsIndexPort,
    type IndexedHead,
    type ScopeIndexPort,
} from "../readiness/tap.js";
import { HeaderV1 } from "../readiness/wire.js";
import { DirectNetwork, sameBytes } from "./readiness-client.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * The change tap (M1 plan section 8: tests 49 and 56). Each case checks the
 * maintained state against a fresh build from the index with the K2 shadow
 * comparison; every close in this file runs that check again.
 */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const until = async (assertion: () => Promise<void> | void) => {
    const deadline = Date.now() + (process.env.CI ? 90_000 : 30_000);
    for (;;) {
        try {
            return await assertion();
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
};

const runtimeOf = (fs: SharedFsHandle): ReadinessRuntime =>
    (fs.program as any).readinessRuntime;
const entriesOf = (fs: SharedFsHandle): any => (fs.program as any).entries;

/** The K2 comparison of one scope, now. */
const shadow = async (
    fs: SharedFsHandle,
    scope: ScopeId = SCOPE_NAMESPACE_V1,
    options?: CompareOptions
) => {
    const runtime = runtimeOf(fs);
    await runtime.whenStarted();
    return compareScope(runtime.scope(scope)!, runtime.cellKey, options);
};

/** Namespace index rows: id -> head. */
const indexHeads = async (fs: SharedFsHandle) => {
    const out = new Map<string, string>();
    for await (const rows of documentsIndexPort(
        entriesOf(fs),
        NAMESPACE_V1
    ).scan()) {
        for (const row of rows) out.set(row.key as string, row.head);
    }
    return out;
};

/** Ids of indexed rows of one kind. */
const idsOf = async (fs: SharedFsHandle, kind: string, n: number) => {
    const rows = await entriesOf(fs)
        .index.index.iterate({ query: [] }, { shape: { id: true, kind: true } })
        .all();
    return rows
        .map((row: any) => row.value)
        .filter((value: any) => value.kind === kind)
        .slice(0, n)
        .map((value: any) => value.id as string);
};

/** The current document of an id, with its `__context`. */
const documentOf = (fs: SharedFsHandle, id: string) =>
    entriesOf(fs).index.get(id, { local: true, remote: false });

const writeFiles = async (fs: SharedFsHandle, n: number, prefix = "f") => {
    for (let i = 0; i < n; i++) {
        await fs.writeFile(`/${prefix}${i}.txt`, `content ${prefix} ${i}`);
    }
};

// ------------------------------------------------------------ fake index

const head = () => digestToHead(randomBytes(DIGEST_BYTES));

/** A namespace value as a remote arrival decodes it: no `kind` field. */
const remoteNaming = (id: string, h?: string, modified = 1n) => {
    const value = Object.create(NamingEvent.prototype);
    value.id = id;
    if (h !== undefined) value.__context = { head: h, modified };
    return value;
};

class FakeIndex implements ScopeIndexPort {
    readonly rows = new Map<string, IndexedHead>();
    reads = 0;
    onCount?: () => void;
    async readHead(key: IdKey) {
        this.reads++;
        await Promise.resolve();
        return this.rows.get(key as string);
    }
    async *scan() {
        await Promise.resolve();
        yield [...this.rows].map(([key, row]) => ({ key, ...row }));
    }
    async count() {
        const n = this.rows.size;
        await Promise.resolve();
        this.onCount?.();
        return n;
    }
    set(id: string, h: string, modified = 1n) {
        this.rows.set(id, { head: h, modified });
    }
}

const change = (added: unknown[], removed: unknown[] = []) => ({
    detail: { added, removed },
});

const mapHead = (tap: ScopeTap, id: string) => {
    const slot = tap.map.get(id);
    return slot < 0 ? undefined : hex(tap.map.head(slot));
};

/** The live tap equals the fake index, row by row. */
const expectTapEqualsIndex = (tap: ScopeTap, index: FakeIndex) => {
    expect(tap.count).toBe(index.rows.size);
    for (const [id, row] of index.rows) {
        expect(mapHead(tap, id)).toBe(hex(headDigest(row.head)));
    }
};

describe("readiness tap", () => {
    describe("rules on a fake index (test 56)", () => {
        it("scopes values by class, so removed values and remote arrivals without `kind` count", async () => {
            const index = new FakeIndex();
            const tap = new ScopeTap(NAMESPACE_V1, index);
            await tap.seedFromScan();
            const [a, b] = [head(), head()];
            const arrival = remoteNaming("n1", a);
            expect(arrival.kind).toBeUndefined();
            index.set("n1", a);
            tap.onChange(change([arrival]));
            // A plain object that claims the kind is not a scope value.
            tap.onChange(
                change([{ id: "fake", kind: "naming", __context: { head: b } }])
            );
            expectTapEqualsIndex(tap, index);

            // A removed value carries neither `kind` nor always a head.
            index.rows.delete("n1");
            tap.onChange(change([], [remoteNaming("n1")]));
            expect(tap.count).toBe(0);
            // The removal had no head, so it is verified against the index.
            await tap.verifyIdle();
            expectTapEqualsIndex(tap, index);
            expect(tap.stats.staleRemoves).toBe(1);
        });

        it("reads `__context` in the listener, so a value mutated later changes nothing", async () => {
            const index = new FakeIndex();
            const tap = new ScopeTap(NAMESPACE_V1, index);
            await tap.seedFromScan();
            const first = head();
            const value = remoteNaming("n1", first, 5n);
            index.set("n1", first, 5n);
            tap.onChange(change([value]));
            // A later put reuses and mutates the same object.
            value.__context.head = head();
            value.__context.modified = 9n;
            expectTapEqualsIndex(tap, index);
            expect(tap.hlc).toBe(5n);
            expect(tap.map.modified(tap.map.get("n1"))).toBe(5n);
        });

        it("buffers events during open and applies them after the seed under the same rules", async () => {
            const index = new FakeIndex();
            const target = new EventTarget();
            const tap = new ScopeTap(NAMESPACE_V1, index);
            tap.attach(target as any);
            const [x, y, z, y2] = [head(), head(), head(), head()];
            // The index already reflects the events dispatched during open
            // (Documents updates its index first): x added, y replaced by y2.
            index.set("x", x, 3n);
            index.set("y", y2, 4n);
            index.set("z", z, 1n);
            const dispatch = (added: unknown[], removed: unknown[] = []) =>
                target.dispatchEvent(
                    new CustomEvent("change", { detail: { added, removed } })
                );
            dispatch([remoteNaming("x", x, 3n)]);
            dispatch([remoteNaming("y", y2, 4n)], [remoteNaming("y", y, 2n)]);
            // A removal of a row the scan never saw.
            dispatch([], [remoteNaming("gone", head(), 1n)]);
            expect(tap.state).toBe("buffering");
            expect(tap.count).toBe(0);
            await tap.seedFromScan();
            expect(tap.state).toBe("live");
            await tap.verifyIdle();
            expectTapEqualsIndex(tap, index);
            expect(tap.hlc).toBe(4n);
            tap.dispose();
        });

        it("ignores empty events and re-dispatched events change nothing (50 of 50)", async () => {
            const index = new FakeIndex();
            const tap = new ScopeTap(NAMESPACE_V1, index);
            await tap.seedFromScan();
            const values = Array.from({ length: 50 }, (_, i) => {
                const h = head();
                index.set(`n${i}`, h, BigInt(i + 1));
                return remoteNaming(`n${i}`, h, BigInt(i + 1));
            });
            tap.onChange(change(values));
            const epoch = tap.epoch;
            tap.onChange(change([], []));
            tap.onChange({ detail: {} });
            expect(tap.stats.emptyEvents).toBe(2);
            const skips = tap.stats.idempotentSkips;
            tap.onChange(change(values));
            expect(tap.stats.idempotentSkips - skips).toBe(50);
            expect(tap.epoch).toBe(epoch);
            expect(tap.pendingVerify).toBe(0);
            expectTapEqualsIndex(tap, index);
        });

        it("repairs an out-of-order replace by reading the indexed head", async () => {
            const index = new FakeIndex();
            const tap = new ScopeTap(NAMESPACE_V1, index);
            await tap.seedFromScan();
            const [older, newer] = [head(), head()];
            index.set("n1", newer, 2n);
            tap.onChange(change([remoteNaming("n1", newer, 2n)]));
            // Documents dispatches the older entry's event after the newer
            // one the index kept.
            tap.onChange(change([remoteNaming("n1", older, 1n)]));
            expect(mapHead(tap, "n1")).toBe(hex(headDigest(older)));
            expect(tap.pendingVerify).toBe(1);
            await tap.verifyIdle();
            expect(tap.stats.repairs).toBe(1);
            expectTapEqualsIndex(tap, index);
            // The maintained hlc never decreases.
            expect(tap.hlc).toBe(2n);
        });

        it("verifies an add of an id an event removed lately (a delete racing a re-put)", async () => {
            // A local delete reads the removed value, deletes the id's whole
            // row and dispatches; a re-put indexed inside that window
            // dispatches its add after the removal. The index holds no row.
            const [h0, h1] = [head(), head()];

            // The id was absent before the re-put: the removal matches
            // nothing, the late add names an absent id.
            const absent = new FakeIndex();
            const first = new ScopeTap(NAMESPACE_V1, absent);
            await first.seedFromScan();
            first.onChange(change([], [remoteNaming("x", h1, 2n)]));
            await first.verifyIdle();
            first.onChange(change([remoteNaming("x", h1, 2n)]));
            expect(first.pendingVerify).toBe(1);
            await first.verifyIdle();
            expectTapEqualsIndex(first, absent);
            expect(first.stats.readdVerifies).toBe(1);

            // The id held h0: the removal of h1 is stale and verified, and
            // that verify ends before the late add lands.
            const present = new FakeIndex();
            present.set("x", h0, 1n);
            const second = new ScopeTap(NAMESPACE_V1, present);
            await second.seedFromScan();
            present.rows.delete("x");
            second.onChange(change([], [remoteNaming("x", h1, 2n)]));
            await second.verifyIdle();
            second.onChange(change([remoteNaming("x", h1, 2n)]));
            await second.verifyIdle();
            expectTapEqualsIndex(second, present);
            expect(second.stats.repairs).toBe(1);

            // The same order buffered during a seed.
            const seeded = new FakeIndex();
            const target = new EventTarget();
            const third = new ScopeTap(NAMESPACE_V1, seeded);
            third.attach(target as any);
            const dispatch = (added: unknown[], removed: unknown[] = []) =>
                target.dispatchEvent(
                    new CustomEvent("change", { detail: { added, removed } })
                );
            dispatch([], [remoteNaming("x", h1, 2n)]);
            dispatch([remoteNaming("x", h1, 2n)]);
            await third.seedFromScan();
            await third.verifyIdle();
            expectTapEqualsIndex(third, seeded);
            expect(await third.restoredCountMatches()).toBe(true);
            third.dispose();

            // A real re-add after a delete is kept by the same verify.
            const readd = new FakeIndex();
            const fourth = new ScopeTap(NAMESPACE_V1, readd);
            await fourth.seedFromScan();
            fourth.onChange(change([], [remoteNaming("y", h0, 1n)]));
            readd.set("y", h1, 2n);
            fourth.onChange(change([remoteNaming("y", h1, 2n)]));
            await fourth.verifyIdle();
            expectTapEqualsIndex(fourth, readd);
            expect(fourth.stats.repairs).toBe(0);
        });

        it("bounds the close's verify wait while replaces of one id keep arriving", async () => {
            let at = 0;
            let reads = 0;
            const port: ScopeIndexPort = {
                readHead: () =>
                    new Promise((resolve) => {
                        reads++;
                        const value = { head: heads[at], modified: 1n };
                        setTimeout(() => resolve(value), 4);
                    }),
                scan: async function* () {},
                count: async () => 1,
            };
            const heads = Array.from({ length: 2000 }, () => head());
            const tap = new ScopeTap(NAMESPACE_V1, port);
            await tap.seedFromScan();
            const put = () =>
                tap.onChange(change([remoteNaming("a", heads[++at])]));
            put();
            put();
            // A remote peer replaces the id every millisecond, faster than
            // one read completes.
            const stream = setInterval(put, 1);
            try {
                const started = Date.now();
                await tap.drainVerifies();
                expect(Date.now() - started).toBeLessThan(500);
                expect(tap.faulted).toBeDefined();
                tap.seal();
                const readsAtSeal = reads;
                await new Promise((resolve) => setTimeout(resolve, 50));
                await tap.verifyIdle();
                // No index read once sealed.
                expect(reads).toBe(readsAtSeal);
            } finally {
                clearInterval(stream);
            }
        });
    });

    describe("on a filesystem (test 49)", () => {
        const peers: Peerbit[] = [];
        afterEach(async () => {
            await stopTestPeers(peers);
        });
        const createPeer = async (options?: any) => {
            const peer = await Peerbit.create(options);
            peers.push(peer);
            return peer;
        };

        it("keeps the shadow equal over non-unique replaces, unique puts over a present row and CUTs", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({
                peerbit: peer,
                rootKey: peer.identity.publicKey,
                gc: false,
            });
            await writeFiles(fs, 30);
            // A trust graph with relations beside the root.
            for (let i = 0; i < 3; i++) {
                await fs.authorizeWriter(
                    (await Ed25519Keypair.create()).publicKey
                );
            }
            expect(await shadow(fs)).toMatchObject({ kind: "equal" });
            const tap = runtimeOf(fs).namespace!;
            const replaces = tap.stats.replaces;

            // A non-unique re-put replaces the row's head.
            for (const id of await idsOf(fs, "naming", 8)) {
                await entriesOf(fs).put(await documentOf(fs, id));
            }
            // A unique put over a present row.
            for (const id of await idsOf(fs, "file-version", 8)) {
                await entriesOf(fs).put(await documentOf(fs, id), {
                    unique: true,
                });
            }
            expect(tap.stats.replaces - replaces).toBeGreaterThanOrEqual(16);
            // CUTs of the namespace rows (Documents deletes, as GC issues).
            for (const id of await idsOf(fs, "file-version", 4)) {
                await entriesOf(fs).del(id);
            }
            await fs.writeFile("/after.txt", "after");
            expect(await shadow(fs)).toMatchObject({ kind: "equal" });
            expect(await shadow(fs, SCOPE_TRUST_V1)).toMatchObject({
                kind: "equal",
            });
        });

        it("keeps the shadow equal on both peers over a remote fork and concurrent same-id re-puts", async () => {
            let partitioned = false;
            const deny = () => partitioned;
            const gater = {
                libp2p: {
                    connectionGater: {
                        denyDialPeer: deny,
                        denyDialMultiaddr: deny,
                        denyInboundConnection: deny,
                        denyOutboundConnection: deny,
                        denyInboundEncryptedConnection: deny,
                        denyOutboundEncryptedConnection: deny,
                        denyInboundUpgradedConnection: deny,
                        denyOutboundUpgradedConnection: deny,
                    },
                },
            };
            const [a, b] = [await createPeer(gater), await createPeer(gater)];
            await a.dial(b);
            const fsA = await openSharedFs({
                peerbit: a,
                machineLabel: "a",
                gc: false,
            });
            await writeFiles(fsA, 20);
            const fsB = await openSharedFs({
                peerbit: b,
                address: fsA.address,
                machineLabel: "b",
                allowPartialWrites: true,
                gc: false,
            });
            const converged = () =>
                until(async () => {
                    const [ha, hb] = [
                        await indexHeads(fsA),
                        await indexHeads(fsB),
                    ];
                    expect(hb.size).toBe(ha.size);
                    for (const [id, h] of ha) expect(hb.get(id)).toBe(h);
                });
            await converged();

            // A fork: both sides edit the same paths while partitioned.
            partitioned = true;
            await a.hangUp(b.identity.publicKey);
            await until(() => {
                expect(a.libp2p.getConnections()).toHaveLength(0);
                expect(b.libp2p.getConnections()).toHaveLength(0);
            });
            for (let i = 0; i < 5; i++) {
                await fsA.writeFile(`/f${i}.txt`, `a ${i}`);
                await fsB.writeFile(`/f${i}.txt`, `b ${i}`);
            }
            await fsB.writeFile("/only-b.txt", "b");
            partitioned = false;
            await a.dial(b);
            await converged();

            // Concurrent same-id re-puts from both peers (non-unique on A,
            // unique on B).
            const ids = await idsOf(fsA, "naming", 12);
            await Promise.all([
                (async () => {
                    for (const id of ids) {
                        const doc = await documentOf(fsA, id);
                        if (doc) await entriesOf(fsA).put(doc);
                    }
                })(),
                (async () => {
                    for (const id of ids.slice(0, 8)) {
                        const doc = await documentOf(fsB, id);
                        if (doc)
                            await entriesOf(fsB).put(doc, { unique: true });
                    }
                })(),
            ]);
            await converged();
            const [sa, sb] = [await shadow(fsA), await shadow(fsB)];
            expect(sa).toMatchObject({ kind: "equal" });
            expect(sb).toMatchObject({ kind: "equal" });
            // Equal sets give equal anchors on both peers.
            const anchor = async (fs: SharedFsHandle) => {
                const runtime = runtimeOf(fs);
                const state = runtime.scope(SCOPE_NAMESPACE_V1)!;
                await state.tap.verifyIdle();
                return hex(await state.laneSet.digestNow().digest);
            };
            expect(await anchor(fsA)).toBe(await anchor(fsB));
        });

        it("registers the steady change listener before it waits for the readiness RPC", async () => {
            // A change dispatched after entries.open() resolves must reach
            // the fresh-open listener or the steady one: no await may come
            // between the first's removal and the second's registration,
            // however long the RPC open takes.
            const peer = await createPeer();
            const original = RPC.prototype.open;
            let held = false;
            let registered: boolean | undefined;
            RPC.prototype.open = function (this: any, ...args: any[]) {
                const program = this.parents?.[0];
                if (held || !(program instanceof SharedFileSystem)) {
                    return original.apply(this, args as any);
                }
                held = true;
                const entries = (program as any).entries;
                const entriesOpen = entries.open.bind(entries);
                let entriesOpened: Promise<unknown> | undefined;
                entries.open = (...openArgs: any[]) =>
                    (entriesOpened = entriesOpen(...openArgs));
                return (async () => {
                    // open() calls entries.open right after this returns.
                    await Promise.resolve();
                    await entriesOpened;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    registered = (program as any).changeListener !== undefined;
                    return original.apply(this, args as any);
                })();
            };
            try {
                const fs = await openSharedFs({ peerbit: peer, gc: false });
                expect(held).toBe(true);
                expect(registered).toBe(true);
                await fs.writeFile("/a.txt", "a");
                expect(await shadow(fs)).toMatchObject({ kind: "equal" });
            } finally {
                RPC.prototype.open = original;
            }
        });

        it("repairs the late add of a re-put whose row a GC delete removed", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer, gc: false });
            await writeFiles(fs, 5);
            const runtime = runtimeOf(fs);
            await runtime.whenStarted();
            const tap = runtime.namespace!;
            const [id] = await idsOf(fs, "file-version", 1);
            const doc = await documentOf(fs, id);
            const late = Object.assign(
                Object.create(Object.getPrototypeOf(doc)),
                doc,
                { __context: { ...doc.__context } }
            );
            // As GC deletes: suppressed, so Guard D does not restore it.
            (fs.program as any).gcSuppressed.add(id);
            await entriesOf(fs).del(id);
            expect((await indexHeads(fs)).has(id)).toBe(false);
            expect(mapHead(tap, id)).toBeUndefined();
            // The add of a re-put indexed before the delete removed the row,
            // dispatched after its removal event.
            tap.onChange(change([late]));
            expect(tap.pendingVerify).toBe(1);
            await tap.verifyIdle();
            expect(mapHead(tap, id)).toBeUndefined();
            expect(tap.stats.readdVerifies).toBe(1);
            expect(await shadow(fs)).toMatchObject({ kind: "equal" });
        });

        it("repairs a remote put whose event Documents dispatches after a newer local one", async () => {
            // Two batches of one store are not serialized: a remote batch
            // can index X@h1, a local put then index X@h2 and dispatch, and
            // the remote batch dispatch X@h1 last. The dispatch is held here
            // to force that order on a real two-peer store.
            const [a, b] = [await createPeer(), await createPeer()];
            await a.dial(b);
            const fsA = await openSharedFs({
                peerbit: a,
                machineLabel: "a",
                gc: false,
            });
            await writeFiles(fsA, 10);
            const fsB = await openSharedFs({
                peerbit: b,
                address: fsA.address,
                machineLabel: "b",
                allowPartialWrites: true,
                gc: false,
            });
            const sameHeads = () =>
                until(async () => {
                    const [ha, hb] = [
                        await indexHeads(fsA),
                        await indexHeads(fsB),
                    ];
                    expect(hb.size).toBe(ha.size);
                    for (const [id, h] of ha) expect(hb.get(id)).toBe(h);
                });
            await sameHeads();
            await runtimeOf(fsB).whenStarted();
            const tap = runtimeOf(fsB).namespace!;
            const [id] = await idsOf(fsA, "naming", 1);

            const entriesB = entriesOf(fsB);
            const dispatch =
                entriesB.dispatchDocumentChangeIfObserved.bind(entriesB);
            let held: unknown;
            let holding = true;
            entriesB.dispatchDocumentChangeIfObserved = (detail: any) => {
                if (
                    holding &&
                    held === undefined &&
                    detail?.added?.some((value: any) => value?.id === id)
                ) {
                    // As dispatched now: a later put may mutate the values.
                    const copy = (value: any) =>
                        Object.assign(
                            Object.create(Object.getPrototypeOf(value)),
                            value,
                            { __context: { ...value.__context } }
                        );
                    held = {
                        added: detail.added.map(copy),
                        removed: detail.removed.map(copy),
                    };
                    return;
                }
                dispatch(detail);
            };
            try {
                // A's re-put reaches B's index; its event is held.
                await entriesOf(fsA).put(await documentOf(fsA, id));
                const h1 = (await indexHeads(fsA)).get(id)!;
                await until(async () =>
                    expect((await indexHeads(fsB)).get(id)).toBe(h1)
                );
                expect(held).toBeDefined();
                holding = false;
                // B's newer put indexes and dispatches first.
                await entriesB.put(await documentOf(fsB, id));
                const h2 = (await indexHeads(fsB)).get(id)!;
                expect(h2).not.toBe(h1);
                expect(mapHead(tap, id)).toBe(hex(headDigest(h2)));
                const repairs = tap.stats.repairs;
                // Then the older event.
                dispatch(held);
                expect(mapHead(tap, id)).toBe(hex(headDigest(h1)));
                await tap.verifyIdle();
                expect(tap.stats.repairs - repairs).toBe(1);
                expect(mapHead(tap, id)).toBe(hex(headDigest(h2)));
            } finally {
                entriesB.dispatchDocumentChangeIfObserved = dispatch;
            }
            await sameHeads();
            expect(await shadow(fsA)).toMatchObject({ kind: "equal" });
            expect(await shadow(fsB)).toMatchObject({ kind: "equal" });
        });

        it("a freeze between an out-of-order event and its verify waits for the verify (S10)", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer, gc: false });
            await writeFiles(fs, 10);
            const runtime = runtimeOf(fs);
            await runtime.whenStarted();
            const tap = runtime.namespace!;
            const [id] = await idsOf(fs, "naming", 1);
            const older = await documentOf(fs, id);
            const olderContext = { ...older.__context };
            await entriesOf(fs).put(older);
            const newer = (await indexHeads(fs)).get(id)!;
            expect(newer).not.toBe(olderContext.head);

            const network = new DirectNetwork();
            const responder = new Responder(
                {
                    openNonce: runtime.openNonce,
                    scope: (scope) => runtime.scope(scope),
                    answering: () => !runtime.blocked && !runtime.disposed,
                },
                {
                    send: network.send,
                    provenance: () => (fs.program as any).readinessProvenance(),
                }
            );
            network.responder = responder;
            const client = network.client(
                (await Ed25519Keypair.create()).publicKey
            );

            // The older entry's event arrives after the newer one (as
            // Documents can dispatch it), straight into the tap.
            const stale = Object.assign(
                Object.create(Object.getPrototypeOf(older)),
                older,
                { __context: olderContext }
            );
            tap.onChange(change([stale]));
            expect(tap.pendingVerify).toBe(1);
            expect(mapHead(tap, id)).toBe(hex(headDigest(olderContext.head)));
            // The freeze is requested inside the verify window.
            client.open({
                scopes: [
                    {
                        scope: SCOPE_NAMESPACE_V1,
                        logId: entriesOf(fs).log.log.id,
                        count: 0,
                    },
                ],
            });
            const header = await client.next(HeaderV1);
            expect(tap.pendingVerify).toBe(0);
            expect(mapHead(tap, id)).toBe(hex(headDigest(newer)));
            const rows = await indexHeads(fs);
            const list = new Uint8Array(rows.size * DIGEST_BYTES);
            [...rows.values()].forEach((h, i) =>
                list.set(headDigest(h), i * DIGEST_BYTES)
            );
            const expected = await runtime
                .scope(SCOPE_NAMESPACE_V1)!
                .laneSet.digestOf(list);
            expect(header.count).toBe(rows.size);
            expect(sameBytes(header.anchor, expected)).toBe(true);
            responder.dispose();
            expect(await shadow(fs)).toMatchObject({ kind: "equal" });
        });

        it("the shadow comparison reports a corrupted map with the count delta and a sample", async () => {
            const peer = await createPeer();
            const fs = await openSharedFs({ peerbit: peer, gc: false });
            await writeFiles(fs, 5);
            const runtime = runtimeOf(fs);
            await runtime.whenStarted();
            // This test corrupts the maintained state on purpose.
            optOutOfReadinessShadow(fs.program);
            const tap = runtime.namespace!;
            const [id] = await idsOf(fs, "file-version", 1);
            // Drop a row from the map only: cells and lanes still hold it.
            tap.map.delete(id);
            // No event will name the row: a short wait is enough.
            const outcome = await shadow(fs, SCOPE_NAMESPACE_V1, {
                eventWaitMs: 50,
            });
            expect(outcome.kind).toBe("different");
            const difference = (outcome as any).difference as string;
            expect(difference).toMatch(/count \d+, index \d+ \(delta -1\)/);
            expect(difference).toMatch(
                /1 rows differ \(missing [0-9a-f]{16}\)/
            );
            // A FileVersion row is scoped by class, like every namespace row.
            expect(
                NAMESPACE_V1.classify(Object.create(FileVersion.prototype))
            ).toBe(true);
        });
    });
});
