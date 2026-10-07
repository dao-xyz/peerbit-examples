import { Ed25519Keypair, randomBytes } from "@peerbit/crypto";
import { RPC } from "@peerbit/rpc";
import { TrustedNetwork } from "@peerbit/trusted-network";
import { Peerbit } from "peerbit";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    COUNT_STRIDE_MAX,
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

        it("scans again when a delete between OFFSET pages hid a row from the seed", async () => {
            // The sqlite3 index pages by OFFSET: a row deleted from a page
            // already read shifts the next page by one, so one row is
            // never seen, and no event names it.
            const index = new FakeIndex();
            for (let i = 0; i < 6; i++) index.set(`n${i}`, head());
            const deleted = index.rows.get("n0")!;
            let race = true;
            index.scan = async function* () {
                for (let offset = 0; ; ) {
                    await Promise.resolve();
                    const page = [...index.rows].slice(offset, offset + 2);
                    offset += page.length;
                    if (page.length === 0) return;
                    yield page.map(([key, row]) => ({ key, ...row }));
                    if (race) {
                        race = false;
                        // A local delete: the index first, then its event.
                        index.rows.delete("n0");
                        target.dispatchEvent(
                            new CustomEvent("change", {
                                detail: {
                                    added: [],
                                    removed: [remoteNaming("n0", deleted.head)],
                                },
                            })
                        );
                    }
                }
            };
            const target = new EventTarget();
            const tap = new ScopeTap(NAMESPACE_V1, index);
            tap.attach(target as any);
            await tap.seedChecked();
            expect(tap.stats.rescans).toBe(1);
            expect(tap.countVerified).toBe(true);
            expectTapEqualsIndex(tap, index);
            expect(mapHead(tap, "n2")).toBeDefined();
            tap.dispose();

            // A quiet seed is compared once and kept.
            const quiet = new ScopeTap(NAMESPACE_V1, index);
            await quiet.seedChecked();
            expect(quiet.stats.rescans).toBe(0);
            expect(quiet.countVerified).toBe(true);
            expectTapEqualsIndex(quiet, index);
        });

        describe("a count check under ingest", () => {
            /**
             * A 40-row index paged by OFFSET (4 rows a page). `deletes(scan)`
             * deletes the first row after the first page of that scan (index
             * first, then its event), so the scan misses a row no event
             * names. `arrivals(count)` adds a row during that count's await,
             * so the comparison sees a change and is inconclusive. `write(n)`
             * adds n rows in one event, as a writer or a remote batch does.
             */
            const offsetIndex = (hooks: {
                deletes: (scan: number) => boolean;
                arrivals: (count: number) => boolean;
            }) => {
                const index = new FakeIndex();
                for (let i = 0; i < 40; i++) index.set(`n${i}`, head());
                const target = new EventTarget();
                const dispatch = (added: unknown[], removed: unknown[] = []) =>
                    target.dispatchEvent(
                        new CustomEvent("change", {
                            detail: { added, removed },
                        })
                    );
                let scans = 0;
                let counts = 0;
                let extra = 0;
                /** Pages each scan read, by scan number. */
                const pages: number[] = [];
                index.scan = async function* () {
                    const scan = ++scans;
                    let deleted = false;
                    for (let offset = 0; ; ) {
                        await Promise.resolve();
                        const page = [...index.rows].slice(offset, offset + 4);
                        offset += page.length;
                        if (page.length === 0) return;
                        pages[scan] = (pages[scan] ?? 0) + 1;
                        yield page.map(([key, row]) => ({ key, ...row }));
                        if (!deleted && hooks.deletes(scan)) {
                            deleted = true;
                            const [key, row] = [...index.rows][0];
                            index.rows.delete(key);
                            dispatch([], [remoteNaming(key, row.head)]);
                        }
                    }
                };
                index.count = async () => {
                    const n = index.rows.size;
                    await Promise.resolve();
                    if (hooks.arrivals(++counts)) {
                        const id = `x${extra++}`;
                        const h = head();
                        index.set(id, h);
                        dispatch([remoteNaming(id, h)]);
                    }
                    return n;
                };
                let written = 0;
                /** Indexes n rows; returns their values, not dispatched. */
                const indexRows = (n: number) =>
                    Array.from({ length: n }, () => {
                        const id = `w${written++}`;
                        const h = head();
                        index.set(id, h);
                        return remoteNaming(id, h);
                    });
                const write = (n = 1) => dispatch(indexRows(n));
                const tap = new ScopeTap(NAMESPACE_V1, index);
                tap.attach(target as any);
                return { index, tap, write, indexRows, dispatch, pages };
            };
            /** Real timers' macrotasks; the fake port settles on microtasks. */
            const flush = async () => {
                for (let i = 0; i < 5; i++) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
            };
            /** Fake timers: the tap must arm none, so only writers count. */
            const fakeTimers = () =>
                vi.useFakeTimers({
                    toFake: [
                        "setTimeout",
                        "clearTimeout",
                        "setInterval",
                        "clearInterval",
                    ],
                });
            /** `write()` every `everyMs` until the returned stop runs. */
            const writer = (write: () => void, everyMs: number) => {
                const handle = setInterval(write, everyMs);
                return () => clearInterval(handle);
            };
            /** Advances fake time; every timer's callbacks settle first. */
            const advance = async (ms: number) => {
                await vi.advanceTimersByTimeAsync(ms);
                await flush();
            };

            afterEach(() => {
                vi.useRealTimers();
            });

            it("verifies a seed that hid a row while a writer keeps writing, without a quiet point", async () => {
                fakeTimers();
                // The seed misses a row, and a row arrives during each of
                // the start's three count reads and during the retry those
                // arrivals start.
                const { index, tap, write } = offsetIndex({
                    deletes: (scan) => scan === 1,
                    arrivals: (count) => count <= 4,
                });
                await tap.seedChecked();
                await tap.countSettled();
                expect(tap.stats.rescans).toBe(0);
                expect(tap.countVerified).toBe(false);
                expect(tap.stats.countReads).toBe(4);
                // Nothing waits for the events to stop.
                expect(vi.getTimerCount()).toBe(0);
                const stop = writer(() => write(), 4);
                // The writer's first event starts the next comparison: the
                // seed's first conclusive difference scans again at once.
                await advance(4);
                expect(tap.stats.rescans).toBe(1);
                expect(tap.countVerified).toBe(true);
                await tap.verifyIdle();
                expectTapEqualsIndex(tap, index);
                // A verified count is not read again, however long the
                // writer goes on.
                const reads = tap.stats.countReads;
                await advance(3_000);
                expect(tap.stats.countReads).toBe(reads);
                expectTapEqualsIndex(tap, index);
                // Only the writer's timer was ever armed.
                expect(vi.getTimerCount()).toBe(1);
                stop();
                expect(vi.getTimerCount()).toBe(0);
                tap.dispose();
            });

            it("checks the rescan too, and scans again once a later change confirms its difference", async () => {
                fakeTimers();
                // The first scan and the rescan right after it both miss a
                // row.
                const { index, tap, write } = offsetIndex({
                    deletes: (scan) => scan <= 2,
                    arrivals: () => false,
                });
                await tap.seedChecked();
                expect(tap.stats.rescans).toBe(1);
                expect(tap.count).toBe(index.rows.size - 1);
                expect(tap.countVerified).toBe(false);
                // The rescan's difference may be a batch in flight: it waits
                // for a change to tell (no timer).
                await flush();
                expect(tap.stats.rescans).toBe(1);
                expect(vi.getTimerCount()).toBe(0);
                const stop = writer(() => write(), 5);
                await advance(5);
                expect(tap.stats.rescans).toBe(2);
                expect(tap.countVerified).toBe(true);
                await tap.verifyIdle();
                expectTapEqualsIndex(tap, index);
                stop();
                tap.dispose();
            });

            it("verifies with a writer every second (no quiet window to starve on)", async () => {
                fakeTimers();
                // Both scans miss a row and the start cannot compare: the
                // old 1 s quiet window never fired under this writer.
                const { index, tap, write } = offsetIndex({
                    deletes: (scan) => scan <= 2,
                    arrivals: (count) => count <= 4,
                });
                await tap.seedChecked();
                await tap.countSettled();
                expect(tap.countVerified).toBe(false);
                const stop = writer(() => write(), 1_000);
                await advance(999);
                expect(tap.stats.countReads).toBe(4);
                // The first write: a conclusive difference, a rescan that
                // misses again, and a difference left to the next change.
                await advance(1);
                expect(tap.stats.rescans).toBe(1);
                expect(tap.countVerified).toBe(false);
                // The second write confirms it.
                await advance(1_000);
                expect(tap.stats.rescans).toBe(2);
                expect(tap.countVerified).toBe(true);
                await tap.verifyIdle();
                expectTapEqualsIndex(tap, index);
                expect(vi.getTimerCount()).toBe(1);
                stop();
                tap.dispose();
            });

            it("keeps a restore it could not compare and verifies it while a writer keeps writing", async () => {
                fakeTimers();
                const restoreUnder = async (drop?: string) => {
                    const { index, tap, write } = offsetIndex({
                        deletes: () => false,
                        arrivals: (count) => count <= 4,
                    });
                    const exact = new ScopeTap(NAMESPACE_V1, index);
                    await exact.seedFromScan();
                    if (drop) exact.map.delete(drop);
                    const restored = exact.map;
                    tap.restore({
                        map: restored,
                        hlc: exact.hlc,
                        epoch: restored.size,
                    });
                    expect(await tap.checkCount()).toBeUndefined();
                    await tap.countSettled();
                    // Kept, not discarded for a scan under the same ingest.
                    expect(tap.map).toBe(restored);
                    expect(tap.countVerified).toBe(false);
                    const stop = writer(() => write(), 3);
                    await advance(3);
                    expect(tap.countVerified).toBe(true);
                    await tap.verifyIdle();
                    expectTapEqualsIndex(tap, index);
                    await advance(300);
                    expectTapEqualsIndex(tap, index);
                    stop();
                    tap.dispose();
                    return { tap, restored };
                };

                // A correct restore is verified as it is.
                const correct = await restoreUnder();
                expect(correct.tap.stats.rescans).toBe(0);
                expect(correct.tap.map).toBe(correct.restored);

                // A stale one (a row missing) is scanned again at its first
                // conclusive comparison.
                const stale = await restoreUnder("n5");
                expect(stale.tap.stats.rescans).toBe(1);
                expect(stale.tap.map).not.toBe(stale.restored);
            });

            it("does not rescan for a batch indexed but not yet dispatched", async () => {
                fakeTimers();
                // The rescan misses a row too, so later differences need a
                // second look.
                const { index, tap, write, indexRows, dispatch } = offsetIndex({
                    deletes: (scan) => scan <= 2,
                    arrivals: () => false,
                });
                await tap.seedChecked();
                expect(tap.stats.rescans).toBe(1);
                // A remote batch indexes 2 rows per tick and dispatches only
                // at its end, while a local writer writes every tick: every
                // comparison sees the missed row plus a growing batch.
                const batch: unknown[] = [];
                const stopBatch = writer(() => {
                    batch.push(...indexRows(2));
                }, 5);
                const stop = writer(() => write(), 5);
                await advance(100);
                expect(tap.stats.deferredCounts).toBeGreaterThan(2);
                expect(tap.stats.rescans).toBe(1);
                expect(tap.countVerified).toBe(false);
                stopBatch();
                dispatch(batch);
                // Once the batch's event applied, the missed row's
                // difference repeats and is scanned again.
                for (let i = 0; i < 200 && !tap.countVerified; i++) {
                    await advance(5);
                }
                expect(tap.stats.rescans).toBe(2);
                expect(tap.countVerified).toBe(true);
                await tap.verifyIdle();
                expectTapEqualsIndex(tap, index);
                stop();
                tap.dispose();
            });

            it("reads the count a bounded number of times while every comparison sees a change", async () => {
                fakeTimers();
                let concurrent = true;
                const { index, tap, write } = offsetIndex({
                    deletes: () => false,
                    arrivals: () => concurrent,
                });
                await tap.seedChecked();
                await tap.countSettled();
                const from = tap.epoch;
                // 600 events of 10 rows each, and a row arriving during
                // every count read.
                const stop = writer(() => write(10), 5);
                await advance(3_000);
                const changes = tap.epoch - from;
                expect(changes).toBeGreaterThan(6_000);
                expect(tap.countVerified).toBe(false);
                // The start's 3 reads, then one per doubling stride up to
                // the cap, then one per COUNT_STRIDE_MAX changes.
                expect(tap.stats.countReads).toBeLessThanOrEqual(
                    3 +
                        Math.log2(COUNT_STRIDE_MAX) +
                        1 +
                        Math.ceil(changes / COUNT_STRIDE_MAX)
                );
                expect(tap.stats.countReads).toBeGreaterThan(10);
                // Once a read sees no change, the next stride verifies.
                concurrent = false;
                await advance(5 * Math.ceil(COUNT_STRIDE_MAX / 10) + 5);
                expect(tap.countVerified).toBe(true);
                await tap.verifyIdle();
                expectTapEqualsIndex(tap, index);
                stop();
                tap.dispose();
            });

            it("compares at once when a consumer reads the state, once per stride", async () => {
                const { tap, write } = offsetIndex({
                    deletes: () => false,
                    arrivals: (count) => count <= 5,
                });
                await tap.seedChecked();
                await tap.countSettled();
                expect(tap.stats.countReads).toBe(4);
                // A consumer asks before the next stride: one read now (a
                // row arrives during it).
                tap.requestCount();
                await tap.countSettled();
                expect(tap.stats.countReads).toBe(5);
                expect(tap.countVerified).toBe(false);
                // Asking again reads nothing until changes start a
                // comparison of their own.
                tap.requestCount();
                await tap.countSettled();
                expect(tap.stats.countReads).toBe(5);
                write(8);
                await tap.countSettled();
                expect(tap.stats.countReads).toBe(6);
                expect(tap.countVerified).toBe(true);
                tap.dispose();
            });

            it("faults a tap whose count never matches its scans, once changes confirm it", async () => {
                fakeTimers();
                const { tap, write } = offsetIndex({
                    deletes: () => true,
                    arrivals: () => false,
                });
                await tap.seedChecked();
                expect(tap.stats.rescans).toBe(1);
                // Quiet: a difference cannot be told from a batch still being
                // indexed, so it stays unverified (never persisted) and
                // nothing is armed.
                await flush();
                await tap.confirmCount();
                expect(tap.stats.rescans).toBe(1);
                expect(tap.faulted).toBeUndefined();
                expect(tap.countVerified).toBe(false);
                expect(vi.getTimerCount()).toBe(0);
                // Each change confirms the difference: rescans, then the
                // fault.
                const stop = writer(() => write(), 5);
                await advance(15);
                expect(tap.stats.rescans).toBe(3);
                expect(tap.countVerified).toBe(false);
                expect(String(tap.faulted)).toMatch(/after 3 rescans/);
                const reads = tap.stats.countReads;
                await advance(50);
                expect(tap.stats.countReads).toBe(reads);
                stop();
                expect(vi.getTimerCount()).toBe(0);
                tap.dispose();
            });

            it("does nothing once sealed or disposed", async () => {
                fakeTimers();
                for (const end of ["seal", "dispose"] as const) {
                    const { tap, write } = offsetIndex({
                        deletes: () => false,
                        arrivals: (count) => count <= 4,
                    });
                    await tap.seedChecked();
                    await tap.countSettled();
                    expect(tap.countVerified).toBe(false);
                    const reads = tap.stats.countReads;
                    if (end === "seal") tap.seal();
                    else tap.dispose();
                    const stop = writer(() => write(), 5);
                    await advance(50);
                    tap.requestCount();
                    await tap.confirmCount();
                    await tap.countSettled();
                    expect(tap.stats.countReads).toBe(reads);
                    expect(tap.countVerified).toBe(false);
                    expect(vi.getTimerCount()).toBe(1);
                    stop();
                    tap.dispose();
                }
            });

            it("reads no further page once sealed during a rescan", async () => {
                let sealNow = () => {};
                // The seal lands after the rescan's first page.
                const { tap, pages } = offsetIndex({
                    deletes: (scan) => {
                        if (scan === 2) sealNow();
                        return scan === 1;
                    },
                    arrivals: () => false,
                });
                sealNow = () => tap.seal();
                await tap.seedChecked();
                expect(tap.stats.rescans).toBe(1);
                // Only the page already requested at the seal; the rescan
                // stays unfinished, so its state is never persisted.
                expect(pages[1]).toBe(10);
                expect(pages[2]).toBe(2);
                expect(tap.state).toBe("buffering");
                expect(tap.stats.countReads).toBe(1);
                tap.dispose();
            });

            it("confirms an unverified count once at close", async () => {
                const { tap } = offsetIndex({
                    deletes: () => false,
                    arrivals: (count) => count <= 4,
                });
                await tap.seedChecked();
                await tap.countSettled();
                expect(tap.countVerified).toBe(false);
                await tap.confirmCount();
                expect(tap.countVerified).toBe(true);
                expect(tap.stats.countReads).toBe(5);
                tap.dispose();
            });
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

        it("listens on the trust graph before its log opens, so a replicated batch cannot start unseen", async () => {
            // Documents decides when a batch starts whether it dispatches a
            // change event: the trust tap must listen before the trust log
            // can replicate one.
            const consumersAtOpen: boolean[] = [];
            const open = TrustedNetwork.prototype.open;
            TrustedNetwork.prototype.open = async function (
                this: any,
                ...args: any[]
            ) {
                // Documents' own count (`hasDocumentChangeConsumers`, which
                // also reads the index, not set up before open).
                const docs = this.trustGraph;
                consumersAtOpen.push(
                    (docs._documentChangeListenerCount ?? 0) >
                        (docs._documentInternalChangeListenerCount ?? 0)
                );
                return open.apply(this, args as any);
            };
            try {
                const [a, b] = [await createPeer(), await createPeer()];
                await a.dial(b);
                const owner = await openSharedFs({
                    peerbit: a,
                    rootKey: a.identity.publicKey,
                    gc: false,
                });
                for (let i = 0; i < 4; i++) {
                    await owner.authorizeWriter(
                        (await Ed25519Keypair.create()).publicKey
                    );
                }
                // A joiner opens by address while relations keep coming.
                const granting = (async () => {
                    for (let i = 0; i < 8; i++) {
                        await owner.authorizeWriter(
                            (await Ed25519Keypair.create()).publicKey
                        );
                    }
                })();
                const joiner = await openSharedFs({
                    peerbit: b,
                    address: owner.address,
                    allowPartialWrites: true,
                    gc: false,
                });
                await granting;
                expect(consumersAtOpen).toEqual([true, true]);
                for (const fs of [owner, joiner]) {
                    // The tap listens on the instance open returned (S8).
                    const trustGraph = (fs.program as any).trustGraph
                        .trustGraph;
                    expect((runtimeOf(fs) as any).trustDocuments).toBe(
                        trustGraph
                    );
                    expect(runtimeOf(fs).starts.get("trust-v1")).toEqual({
                        kind: "scanned",
                    });
                }
                await until(async () => {
                    expect(
                        await shadow(joiner, SCOPE_TRUST_V1, {
                            eventWaitMs: 1_000,
                        })
                    ).toMatchObject({ kind: "equal" });
                    expect(runtimeOf(joiner).trust!.count).toBe(
                        runtimeOf(owner).trust!.count
                    );
                });
            } finally {
                TrustedNetwork.prototype.open = open;
            }
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
