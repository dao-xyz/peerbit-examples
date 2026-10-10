import { deserialize, field, serialize, variant } from "@dao-xyz/borsh";
import { Ed25519Keypair, PublicSignKey, randomBytes } from "@peerbit/crypto";
import { Documents } from "@peerbit/document";
import { Timestamp } from "@peerbit/log";
import { Program } from "@peerbit/program";
import { Peerbit } from "peerbit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PULL_BATCH } from "../readiness/constants.js";
import {
    Explainer,
    RejectionRecord,
    newestWinsIgnores,
    type EntryFacts,
    type ExplainPorts,
    type Rejection,
} from "../readiness/explain.js";
import type { IdKey } from "../readiness/id-map.js";
import type { IndexedHead } from "../readiness/tap.js";
import { stopTestPeers } from "./stop-test-peers.js";

/**
 * Explained rows (design 4.6, M1 plan section 7.3): the unit halves of
 * tests 39 (a CUT J holds supersedes the head it names), 41 (a re-put of a
 * cut id is required), 52 (ignored-older), 44 (a logged head waits for its
 * event and is never pulled), the rejection record with the signers a trust
 * refusal records (PR-3 commit 3) and the order of the verdicts. The explainer runs on a fake log and index here; commit 2 binds
 * the ports to the store and runs 39, 41 and 52 end to end.
 *
 * The newest-wins pin runs Documents itself (`@peerbit/document` 15.1.11):
 * `newestWinsIgnores` must make the same decision as
 * `dist/src/program.js:3814-3832`, where a remote arrival of an id J
 * already indexes is ignored only when the indexed `__context.modified` is
 * strictly greater than the entry's wall time, and a local `unique` put
 * never reads the indexed row (`program.js:3815`).
 */

// ------------------------------------------------------------ fake store

interface LogEntry {
    facts: EntryFacts;
    /** `meta.next`. */
    next: string[];
}

/** J's log and index of one scope, behind `ExplainPorts`. */
class FakeJoiner {
    readonly log = new Map<string, LogEntry>();
    readonly index = new Map<string, IndexedHead>();
    readonly calls = { hasNext: 0, inspect: 0, readHead: 0 };
    fail?: "hasNext" | "inspect" | "readHead";

    readonly ports: ExplainPorts = {
        hasNext: async (head) => {
            this.calls.hasNext++;
            if (this.fail === "hasNext") throw new Error("hasNext failed");
            for (const entry of this.log.values()) {
                if (entry.next.includes(head)) return true;
            }
            return false;
        },
        inspect: async (head) => {
            this.calls.inspect++;
            if (this.fail === "inspect") throw new Error("inspect failed");
            return this.log.get(head)?.facts;
        },
        readHead: async (key: IdKey) => {
            this.calls.readHead++;
            if (this.fail === "readHead") throw new Error("readHead failed");
            return this.index.get(key as string);
        },
    };

    /** A put of document `key` in J's log. */
    put(head: string, key: string, wallTime: bigint, next: string[] = []) {
        this.log.set(head, {
            facts: { kind: "row", key, wallTime },
            next,
        });
    }

    /** A Documents delete: a CUT whose `next` is exactly the removed head. */
    cut(head: string, target: string) {
        this.log.set(head, {
            facts: { kind: "not-row", detail: "a delete" },
            next: [target],
        });
    }

    indexRow(key: string, head: string, modified: bigint) {
        this.index.set(key, { head, modified });
    }
}

const NONE: ReadonlyMap<string, Rejection> = new Map();
const rejected = (reason: Rejection["reason"], head = "h") =>
    new Map<string, Rejection>([
        [head, { permanent: reason === "structure", reason }],
    ]);

describe("readiness explain", () => {
    it("39: a CUT in J's log supersedes the head it names, so it is not pulled", async () => {
        const j = new FakeJoiner();
        j.cut("cut1", "h");
        const explainer = new Explainer(j.ports);
        expect(await explainer.beforePull(["h"])).toEqual([
            { kind: "explained", reason: "superseded" },
        ]);
        // Superseded is decided by the lookup alone.
        expect(j.calls.inspect).toBe(0);
        expect(await explainer.afterPull(["h"], NONE)).toEqual([
            { kind: "explained", reason: "superseded" },
        ]);
        // Also when J holds the head itself, indexed or not.
        j.put("h", "x", 5n);
        expect(await explainer.beforePull(["h"])).toEqual([
            { kind: "explained", reason: "superseded" },
        ]);
        // A later put of the same document names the head as well.
        const k = new FakeJoiner();
        k.put("h", "x", 5n);
        k.put("h-next", "x", 6n, ["h"]);
        k.indexRow("x", "h-next", 6n);
        expect(await new Explainer(k.ports).beforePull(["h"])).toEqual([
            { kind: "explained", reason: "superseded" },
        ]);
        // The CUT itself is not a row: a peer that names it lied.
        expect(await explainer.beforePull(["cut1"])).toEqual([
            { kind: "lie", detail: "a delete" },
        ]);
    });

    it("41: the re-put of a cut id is pulled and required", async () => {
        const j = new FakeJoiner();
        // J holds the stale CUT of h1; Guard D re-put the id as h2 (a unique
        // put: no `next`).
        j.cut("cut1", "h1");
        const explainer = new Explainer(j.ports);
        expect(await explainer.beforePull(["h1", "h2"])).toEqual([
            { kind: "explained", reason: "superseded" },
            { kind: "pull" },
        ]);
        // Still missing after the pull: fetch-failed, never explained.
        expect(await explainer.afterPull(["h2"], NONE)).toEqual([
            { kind: "failed" },
        ]);
        // Pulled, index write pending: wait for its event.
        j.put("h2", "x", 9n);
        expect(await explainer.afterPull(["h2"], NONE)).toEqual([
            { kind: "logged" },
        ]);
        // Indexed: the session asks J's maintained set whether it holds it
        // or waits for the event.
        j.indexRow("x", "h2", 9n);
        expect(await explainer.afterPull(["h2"], NONE)).toEqual([
            { kind: "indexed", key: "x" },
        ]);
    });

    it("52: ignored-older only when J's indexed row is strictly newer", async () => {
        const m = 1_000n;
        for (const [w, expected] of [
            [m - 1n, { kind: "explained", reason: "ignored-older" }],
            [m, { kind: "logged" }],
            [m + 1n, { kind: "logged" }],
        ] as const) {
            const j = new FakeJoiner();
            j.put("d", "x", m);
            j.indexRow("x", "d", m);
            // R's older head of the same id, in J's log, not indexed.
            j.put("h", "x", w);
            const explainer = new Explainer(j.ports);
            expect(await explainer.afterPull(["h"], NONE)).toEqual([expected]);
            expect(await explainer.beforePull(["h"])).toEqual([expected]);
        }
        // No indexed row for the id: the index write is pending.
        const j = new FakeJoiner();
        j.put("h", "x", 1n);
        expect(await new Explainer(j.ports).afterPull(["h"], NONE)).toEqual([
            { kind: "logged" },
        ]);
    });

    it("44 (unit): a logged head with a delayed index write is never pulled", async () => {
        const j = new FakeJoiner();
        j.put("h", "x", 7n);
        const explainer = new Explainer(j.ports);
        expect(await explainer.beforePull(["h"])).toEqual([{ kind: "logged" }]);
        expect(await explainer.afterPull(["h"], NONE)).toEqual([
            { kind: "logged" },
        ]);
        // The index write lands: the change event drains it, or the
        // session finds its maintained set holds it already.
        j.indexRow("x", "h", 7n);
        expect(await explainer.beforePull(["h"])).toEqual([
            { kind: "indexed", key: "x" },
        ]);
    });

    it("classifies a pulled head by its recorded rejection", async () => {
        const j = new FakeJoiner();
        const explainer = new Explainer(j.ports);
        expect(await explainer.afterPull(["h"], rejected("structure"))).toEqual(
            [{ kind: "explained", reason: "rejected-structure" }]
        );
        // Only a permanent refusal explains: a structure label on one a later
        // state reverses (a clock-skew bound, an inner signer not trusted
        // yet) is a mislabel, and the head is pulled again.
        expect(
            await explainer.afterPull(
                ["h"],
                new Map([["h", { permanent: false, reason: "structure" }]])
            )
        ).toEqual([{ kind: "failed" }]);
        expect(await explainer.afterPull(["h"], rejected("untrusted"))).toEqual(
            [{ kind: "trust-pending" }]
        );
        expect(
            await explainer.afterPull(["h"], rejected("trust-cache"))
        ).toEqual([{ kind: "trust-pending" }]);
        // A transient refusal says nothing: absent from the log is failed.
        expect(await explainer.afterPull(["h"], rejected("transient"))).toEqual(
            [{ kind: "failed" }]
        );
        // A rejection of another head does not apply.
        expect(
            await explainer.afterPull(["h"], rejected("structure", "other"))
        ).toEqual([{ kind: "failed" }]);

        // A rejection speaks only for an entry J's log lacks: one in the log
        // passed canPerform once (the trust cache refused one push, a later
        // one was accepted), so its index write decides.
        j.put("h", "x", 1n);
        for (const reason of [
            "structure",
            "untrusted",
            "trust-cache",
            "transient",
        ] as const) {
            expect(await explainer.afterPull(["h"], rejected(reason))).toEqual([
                { kind: "logged" },
            ]);
        }
        j.indexRow("x", "newer", 2n);
        expect(await explainer.afterPull(["h"], rejected("untrusted"))).toEqual(
            [{ kind: "explained", reason: "ignored-older" }]
        );

        // Explained comes before trust-pending (design 4.5 step 8): a CUT
        // J holds explains the head whatever canPerform said about it.
        const k = new FakeJoiner();
        k.cut("cut", "h");
        expect(
            await new Explainer(k.ports).afterPull(["h"], rejected("untrusted"))
        ).toEqual([{ kind: "explained", reason: "superseded" }]);
        // A failed lookup is unknown whatever was recorded: the hash stays
        // pending and is classified again.
        const broken = new FakeJoiner();
        for (const fail of ["hasNext", "inspect"] as const) {
            broken.fail = fail;
            for (const reason of ["structure", "untrusted"] as const) {
                expect(
                    await new Explainer(broken.ports).afterPull(
                        ["h"],
                        rejected(reason)
                    )
                ).toEqual([{ kind: "unknown" }]);
            }
        }
    });

    it("E1: a trust refusal with signers is trust-pending with its reason and signers; without them, plain", async () => {
        const j = new FakeJoiner();
        const explainer = new Explainer(j.ports);
        const [w1, w2] = await Promise.all([
            Ed25519Keypair.create(),
            Ed25519Keypair.create(),
        ]);
        const signers = [w1.publicKey, w2.publicKey];
        for (const reason of ["untrusted", "trust-cache"] as const) {
            const [verdict] = await explainer.afterPull(
                ["h"],
                new Map([["h", { permanent: false, reason, signers }]])
            );
            expect(verdict).toEqual({ kind: "trust-pending", reason, signers });
            // The session reads the signers; never a copy that drops one.
            expect((verdict as any).signers).toBe(signers);
            // Without signers (and with none) the verdict is the plain one.
            expect(await explainer.afterPull(["h"], rejected(reason))).toEqual([
                { kind: "trust-pending" },
            ]);
            expect(
                await explainer.afterPull(
                    ["h"],
                    new Map([["h", { permanent: false, reason, signers: [] }]])
                )
            ).toEqual([{ kind: "trust-pending" }]);
        }
        // Signers say nothing about another class of refusal, or an entry
        // J's log holds.
        expect(
            await explainer.afterPull(
                ["h"],
                new Map([
                    ["h", { permanent: true, reason: "structure", signers }],
                ])
            )
        ).toEqual([{ kind: "explained", reason: "rejected-structure" }]);
        j.put("h", "x", 1n);
        expect(
            await explainer.afterPull(
                ["h"],
                new Map([
                    ["h", { permanent: false, reason: "untrusted", signers }],
                ])
            )
        ).toEqual([{ kind: "logged" }]);
    });

    it("orders its verdicts: not-row is a lie, undecodable is logged, a failing port is unknown", async () => {
        const j = new FakeJoiner();
        j.log.set("chunk", {
            facts: { kind: "not-row", detail: "a FileChunk put" },
            next: [],
        });
        j.log.set("garbled", {
            facts: { kind: "unknown", detail: "undecodable payload" },
            next: [],
        });
        j.put("live", "x", 3n);
        j.indexRow("x", "live", 3n);
        const explainer = new Explainer(j.ports);
        const heads = ["chunk", "garbled", "live", "absent"];
        expect(await explainer.beforePull(heads)).toEqual([
            { kind: "lie", detail: "a FileChunk put" },
            { kind: "logged" },
            { kind: "indexed", key: "x" },
            { kind: "pull" },
        ]);
        expect(await explainer.afterPull(heads, NONE)).toEqual([
            { kind: "lie", detail: "a FileChunk put" },
            { kind: "logged" },
            { kind: "indexed", key: "x" },
            { kind: "failed" },
        ]);

        for (const fail of ["hasNext", "inspect", "readHead"] as const) {
            j.fail = fail;
            expect(await explainer.beforePull(["live"])).toEqual([
                { kind: "unknown" },
            ]);
            expect(await explainer.afterPull(["live"], NONE)).toEqual([
                { kind: "unknown" },
            ]);
        }
    });

    it("runs the lookups of one call concurrently", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let started = 0;
        const explainer = new Explainer({
            hasNext: async () => {
                started++;
                await gate;
                return false;
            },
            inspect: async () => undefined,
            readHead: async () => undefined,
        });
        const heads = Array.from({ length: PULL_BATCH }, (_, i) => `h${i}`);
        const verdicts = explainer.beforePull(heads);
        await Promise.resolve();
        expect(started).toBe(PULL_BATCH);
        release();
        expect((await verdicts).every((v) => v.kind === "pull")).toBe(true);
    });

    it("newestWinsIgnores is the strict comparison", () => {
        expect(newestWinsIgnores(5n, 4n)).toBe(true);
        expect(newestWinsIgnores(5n, 5n)).toBe(false);
        expect(newestWinsIgnores(5n, 6n)).toBe(false);
        expect(newestWinsIgnores(0n, 0n)).toBe(false);
        const max = (1n << 64n) - 1n;
        expect(newestWinsIgnores(max, max - 1n)).toBe(true);
        expect(newestWinsIgnores(max - 1n, max)).toBe(false);
    });

    describe("rejection record", () => {
        const structure: Rejection = { permanent: true, reason: "structure" };
        const untrusted: Rejection = { permanent: false, reason: "untrusted" };
        const transient: Rejection = { permanent: false, reason: "transient" };

        it("records only tracked heads", () => {
            const record = new RejectionRecord();
            expect(record.note("h", structure)).toBe(false);
            record.track(["h"]);
            expect(record.take(["h"]).size).toBe(0);
            expect(record.note("h", structure)).toBe(true);
            expect(record.take(["h", "other"])).toEqual(
                new Map([["h", structure]])
            );
            // A copy: taking twice gives the same record.
            expect(record.take(["h"]).get("h")).toEqual(structure);
            record.release(["h"]);
            expect(record.tracked("h")).toBe(false);
            expect(record.take(["h"]).size).toBe(0);
            // Tracked again later: the old record is gone.
            record.track(["h"]);
            expect(record.take(["h"]).size).toBe(0);
        });

        it("refcounts overlapping trackers", () => {
            const record = new RejectionRecord();
            record.track(["a", "b"]);
            record.track(["b", "c", "c"]);
            expect(record.size).toBe(3);
            record.note("b", untrusted);
            record.release(["a", "b"]);
            expect(record.tracked("a")).toBe(false);
            expect(record.tracked("b")).toBe(true);
            expect(record.take(["b"]).get("b")).toEqual(untrusted);
            record.release(["b", "c"]);
            expect(record.size).toBe(0);
            // Releasing an untracked head is harmless.
            record.release(["zz"]);
            expect(record.size).toBe(0);
        });

        it("keeps the strongest reason of a head refused twice", () => {
            const record = new RejectionRecord();
            record.track(["a", "b"]);
            record.note("a", transient);
            record.note("a", untrusted);
            record.note("b", structure);
            record.note("b", transient);
            expect(record.take(["a", "b"])).toEqual(
                new Map([
                    ["a", untrusted],
                    ["b", structure],
                ])
            );
        });

        it("E2: unions the signers at an equal rank by hashcode, replaces them at a higher one, and copies them", async () => {
            const [a, b, c] = await Promise.all(
                [0, 1, 2].map(() => Ed25519Keypair.create())
            );
            const hashes = (rejection?: Rejection) =>
                rejection?.signers?.map((key: PublicSignKey) => key.hashcode());
            const record = new RejectionRecord();
            record.track(["h", "g"]);
            const first: Rejection = {
                permanent: false,
                reason: "trust-cache",
                signers: [a.publicKey, b.publicKey],
            };
            record.note("h", first);
            // Equal rank: the union, each key once (b decoded again is
            // another instance of the same key).
            const bAgain = deserialize(serialize(b.publicKey), PublicSignKey);
            expect(bAgain).not.toBe(b.publicKey);
            record.note("h", {
                permanent: false,
                reason: "trust-cache",
                signers: [bAgain, c.publicKey],
            });
            expect(hashes(record.take(["h"]).get("h"))).toEqual([
                a.publicKey.hashcode(),
                b.publicKey.hashcode(),
                c.publicKey.hashcode(),
            ]);
            // Equal rank without signers keeps them.
            record.note("h", { permanent: false, reason: "trust-cache" });
            expect(hashes(record.take(["h"]).get("h"))).toHaveLength(3);
            // A higher rank replaces them, a lower one changes nothing.
            record.note("h", {
                permanent: false,
                reason: "untrusted",
                signers: [c.publicKey],
            });
            record.note("h", {
                permanent: false,
                reason: "trust-cache",
                signers: [a.publicKey],
            });
            const held = record.take(["h"]).get("h")!;
            expect(held.reason).toBe("untrusted");
            expect(hashes(held)).toEqual([c.publicKey.hashcode()]);
            // A structural refusal outranks a trust one and has no signers.
            record.note("h", { permanent: true, reason: "structure" });
            expect(record.take(["h"]).get("h")).toEqual({
                permanent: true,
                reason: "structure",
            });
            // `take` copies: the record holds its own array.
            const noted: Rejection = {
                permanent: false,
                reason: "untrusted",
                signers: [a.publicKey],
            };
            record.note("g", noted);
            const taken = record.take(["g"]).get("g")!;
            expect(taken).not.toBe(noted);
            expect(taken.signers).not.toBe(noted.signers);
            (noted.signers as PublicSignKey[]).push(b.publicKey);
            expect(hashes(record.take(["g"]).get("g"))).toEqual([
                a.publicKey.hashcode(),
            ]);
            record.release(["h", "g"]);
            expect(record.size).toBe(0);
        });

        it("sets no cap of its own: the joins in flight bound it", () => {
            // Four live sessions' batches plus the batch of one that ended
            // and whose join still runs (design 4.6: bounded by the hashes
            // in flight, never a failure).
            const record = new RejectionRecord();
            for (let batch = 0; batch < 5; batch++) {
                record.track(
                    Array.from(
                        { length: PULL_BATCH },
                        (_, i) => `b${batch}-${i}`
                    )
                );
            }
            expect(record.size).toBe(5 * PULL_BATCH);
            expect(record.note(`b4-${PULL_BATCH - 1}`, structure)).toBe(true);
        });
    });
});

// ---------------------------------------------- newest-wins against Documents

@variant("shared_fs_readiness_pin_doc")
class PinDoc {
    @field({ type: "string" })
    id: string;

    @field({ type: "string" })
    value: string;

    constructor(properties?: { id: string; value: string }) {
        this.id = properties?.id as string;
        this.value = properties?.value as string;
    }
}

@variant("shared_fs_readiness_pin_store")
class PinStore extends Program {
    @field({ type: Documents })
    docs: Documents<PinDoc>;

    constructor() {
        super();
        this.docs = new Documents<PinDoc>({ id: randomBytes(32) });
    }

    async open(): Promise<void> {
        // As shared-fs opens its stores: mutable (`immutable` false),
        // `strictHistory` off, the default document mode.
        await this.docs.open({ type: PinDoc, replicate: { factor: 1 } });
    }
}

describe("newest-wins pin: @peerbit/document 15.1.11 program.js:3814-3832", () => {
    const peers: Peerbit[] = [];
    let r: Peerbit;
    let j: Peerbit;

    beforeAll(async () => {
        // Two unconnected clients: entries move only by `log.join`.
        r = await Peerbit.create();
        peers.push(r);
        j = await Peerbit.create();
        peers.push(j);
    });

    afterAll(async () => {
        await stopTestPeers(peers);
    });

    /** The same store opened on R and on J. */
    const openPair = async () => {
        const template = new PinStore();
        const onR = await r.open(template.clone());
        const onJ = await j.open(template.clone());
        expect(onJ.address).toBe(onR.address);
        expect(onJ.docs.immutable).toBe(false);
        return { onR, onJ };
    };

    const at = (wallTime: bigint) => ({
        meta: { timestamp: new Timestamp({ wallTime }) },
    });

    /** Heads of every document J's change events added. */
    const addedHeads = (store: PinStore) => {
        const heads: string[] = [];
        store.docs.events.addEventListener("change", (event) => {
            for (const value of event.detail.added) {
                heads.push((value as any).__context.head);
            }
        });
        return heads;
    };

    const indexed = async (store: PinStore, id: string) => {
        const row: any = await store.docs.index.get(id, {
            local: true,
            remote: false,
        });
        return {
            head: row?.__context?.head as string | undefined,
            modified:
                row?.__context?.modified === undefined
                    ? undefined
                    : BigInt(row.__context.modified),
        };
    };

    // A base in the past, in nanoseconds like the HLC's wall time.
    const base = 1_700_000_000_000_000_000n;

    it.each([
        { label: "older: ignored", indexedAt: 2_000n, wallTime: 1_000n },
        { label: "equal: indexed", indexedAt: 2_000n, wallTime: 2_000n },
        { label: "newer: indexed", indexedAt: 2_000n, wallTime: 3_000n },
    ])(
        "a remote arrival of an indexed id, $label",
        async ({ indexedAt, wallTime }) => {
            const { onR, onJ } = await openPair();
            const own = await onJ.docs.put(
                new PinDoc({ id: "x", value: "j" }),
                at(base + indexedAt)
            );
            const theirs = await onR.docs.put(
                new PinDoc({ id: "x", value: "r" }),
                at(base + wallTime)
            );
            const ignores = newestWinsIgnores(
                base + indexedAt,
                theirs.entry.meta.clock.timestamp.wallTime
            );
            expect(await indexed(onJ, "x")).toEqual({
                head: own.entry.hash,
                modified: base + indexedAt,
            });

            const added = addedHeads(onJ);
            await onJ.docs.log.join([theirs.entry]);
            // A local put after the join: its event comes after any event
            // of the join.
            const sentinel = await onJ.docs.put(
                new PinDoc({ id: "sentinel", value: "s" })
            );
            expect(added).toContain(sentinel.entry.hash);

            // J's log holds the arrival either way.
            expect(await onJ.docs.log.log.has(theirs.entry.hash)).toBe(true);
            const row = await indexed(onJ, "x");
            if (ignores) {
                expect(row).toEqual({
                    head: own.entry.hash,
                    modified: base + indexedAt,
                });
                expect(added).not.toContain(theirs.entry.hash);
            } else {
                expect(row).toEqual({
                    head: theirs.entry.hash,
                    modified: base + wallTime,
                });
                expect(added).toContain(theirs.entry.hash);
            }
            // The explainer, on J's real index read, agrees.
            const verdicts = await new Explainer({
                hasNext: async () => false,
                inspect: async () => ({
                    kind: "row",
                    key: "x",
                    wallTime: base + wallTime,
                }),
                readHead: async () => {
                    const now = await indexed(onJ, "x");
                    return now.head === undefined
                        ? undefined
                        : { head: now.head, modified: now.modified! };
                },
            }).afterPull([theirs.entry.hash], NONE);
            expect(verdicts).toEqual([
                ignores
                    ? { kind: "explained", reason: "ignored-older" }
                    : { kind: "indexed", key: "x" },
            ]);
        }
    );

    it("a remote unique put is compared like any arrival", async () => {
        const { onR, onJ } = await openPair();
        const own = await onJ.docs.put(
            new PinDoc({ id: "x", value: "j" }),
            at(base + 2_000n)
        );
        const theirs = await onR.docs.put(new PinDoc({ id: "x", value: "r" }), {
            ...at(base + 1_000n),
            unique: true,
        });
        expect(newestWinsIgnores(base + 2_000n, base + 1_000n)).toBe(true);
        await onJ.docs.log.join([theirs.entry]);
        expect(await onJ.docs.log.log.has(theirs.entry.hash)).toBe(true);
        expect((await indexed(onJ, "x")).head).toBe(own.entry.hash);
    });

    it("a local unique put over a newer row is indexed (program.js:3815)", async () => {
        const { onJ } = await openPair();
        await onJ.docs.put(
            new PinDoc({ id: "x", value: "newer" }),
            at(base + 5_000n)
        );
        const added = addedHeads(onJ);
        const unique = await onJ.docs.put(
            new PinDoc({ id: "x", value: "older" }),
            { ...at(base + 1_000n), unique: true }
        );
        // newestWinsIgnores would ignore it as an arrival; a local unique
        // put never reads the indexed row, so it is indexed and never
        // pending.
        expect(newestWinsIgnores(base + 5_000n, base + 1_000n)).toBe(true);
        expect(await indexed(onJ, "x")).toEqual({
            head: unique.entry.hash,
            modified: base + 1_000n,
        });
        expect(added).toContain(unique.entry.hash);
    });

    it("a delete is a CUT whose next is exactly the removed head; a re-put is named by nothing", async () => {
        const { onJ } = await openPair();
        const hasNext = async (head: string) => {
            const iterator = onJ.docs.log.log.entryIndex.getHasNext(
                head,
                false
            );
            try {
                return (await iterator.next(1)).length > 0;
            } finally {
                await iterator.close();
            }
        };
        const put = await onJ.docs.put(new PinDoc({ id: "y", value: "1" }));
        expect(await hasNext(put.entry.hash)).toBe(false);
        const cut = await onJ.docs.del("y");
        expect(cut.entry.meta.next).toEqual([put.entry.hash]);
        expect(await hasNext(put.entry.hash)).toBe(true);
        // The recovery re-put of the same id (Guard D, GC): a new entry.
        const reput = await onJ.docs.put(new PinDoc({ id: "y", value: "2" }), {
            unique: true,
        });
        expect(await hasNext(reput.entry.hash)).toBe(false);
        expect((await indexed(onJ, "y")).head).toBe(reput.entry.hash);
    });
});
